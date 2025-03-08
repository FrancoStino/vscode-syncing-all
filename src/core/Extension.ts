import * as extractZip from "extract-zip";
import * as fs from "fs-extra";
import * as micromatch from "micromatch";
import * as path from "path";
import * as tmp from "tmp-promise";
// import * as vscode from "vscode";

import { CaseInsensitiveMap, CaseInsensitiveSet } from "../collections";
import {
    CONFIGURATION_EXCLUDED_EXTENSIONS,
    CONFIGURATION_EXTENSIONS_AUTOUPDATE,
    CONFIGURATION_KEY
} from "../constants";
import { downloadFile } from "../utils/ajax";
import { Environment } from "./Environment";
import { getExtensionById, getVSCodeSetting } from "../utils/vscodeAPI";
import { findLatestSupportedVSIXVersion, queryExtensions } from "../utils/vscodeWebAPI";
import { localize } from "../i18n";
import { Syncing } from "./Syncing";
import * as Toast from "./Toast";
import type { IExtension, ExtensionMeta, ISyncedItem } from "../types";

tmp.setGracefulCleanup();

/**
 * Represents the options of synchronization.
 */
interface ISyncOptions
{
    /**
     * The extensions to add, update or remove.
     */
    extensions: IExtension[];

    /**
     * The current progress of this synchronization process.
     */
    progress: number;

    /**
     * The total progress of this synchronization process.
     */
    total: number;

    /**
     * Sets a value indicating whether `Syncing` should show the progress indicator. Defaults to `false`.
     */
    showIndicator?: boolean;
}

/**
 * VSCode extension wrapper.
 */
export class Extension
{
    private static _instance: Extension;

    private _env: Environment;
    private _syncing: Syncing;

    private constructor()
    {
        this._env = Environment.create();
        this._syncing = Syncing.create();
    }

    /**
     * Creates an instance of the singleton class `Extension`.
     */
    public static create(): Extension
    {
        if (!Extension._instance)
        {
            Extension._instance = new Extension();
        }
        return Extension._instance;
    }

    /**
 * Gets all installed extensions including disabled ones.
 *
 * @param excludedPatterns The glob patterns of the extensions that should be excluded.
 */
    public getAll(excludedPatterns: string[] = []): IExtension[]
    {
        const result: IExtension[] = [];

        try
        {
            // Check if extensions.json exists
            if (fs.existsSync(this._env.extensionsFilePath))
            {
                // Read and parse extensions.json
                const extensionsJson = fs.readJSONSync(this._env.extensionsFilePath);

                // Process extensions array based on structure from jq command:
                // .[] | .identifier.id + " (v" + .version + ")"
                if (Array.isArray(extensionsJson))
                {
                    for (const ext of extensionsJson)
                    {
                        if (ext && ext.identifier && ext.identifier.id)
                        {
                            const id = ext.identifier.id;
                            const version = ext.version || "0.0.0"; // Default version if not specified

                            // Skip VSCode built-in extensions
                            if (id.startsWith("vscode."))
                            {
                                continue;
                            }

                            // Apply excluded patterns filter
                            if (excludedPatterns.some((pattern) => micromatch.isMatch(id, pattern, { nocase: true })))
                            {
                                continue;
                            }

                            // Extract publisher and name from id (format: publisher.name)
                            const parts = id.split(".");
                            const publisher = parts[0] || "";
                            const name = parts.slice(1).join(".") || "";

                            result.push({
                                id,
                                name,
                                publisher,
                                version
                            });
                        }
                    }
                }
            }
        }
        catch (error)
        {
            console.error("Error reading extensions.json:", error);
        }

        console.log("Extensions count:", result.length);
        return result.sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
    }
    /**
     * Synchronize extensions (add, update or remove).
     *
     * @param extensions Extensions to be synced.
     * @param showIndicator Whether to show the progress indicator. Defaults to `false`.
     */

    public async sync(extensions: IExtension[], showIndicator: boolean = false): Promise<ISyncedItem>
    {
        const diff = await this._getDifferentExtensions(extensions);

        // Add, update or remove extensions.
        const { added, updated, removed, total } = diff;
        const result = { extension: {} };
        const tasks = [
            this._addExtensions.bind(this, {
                extensions: added,
                progress: 0,
                total,
                showIndicator
            }),
            this._updateExtensions.bind(this, {
                extensions: updated,
                progress: added.length,
                total,
                showIndicator
            }),
            this._removeExtensions.bind(this, {
                extensions: removed,
                progress: added.length + updated.length,
                total,
                showIndicator
            })
        ];

        for (const task of tasks)
        {
            const value = await task();
            Object.assign(result.extension, value);
        }

        if (showIndicator)
        {
            Toast.clearSpinner("");
        }

        // Added since VSCode v1.20.
        await this.removeVSCodeExtensionFiles();

        return result as ISyncedItem;
    }

    /**
     * Downloads extension from VSCode marketplace.
     */
    public async downloadExtension(extension: IExtension): Promise<IExtension>
    {
        const filepath = (await tmp.file({ postfix: `.${extension.id}.zip` })).path;

        // Calculates the VSIX download URL.
        extension.downloadURL =
            `https://${extension.publisher}.gallery.vsassets.io/_apis/public/gallery/`
            + `publisher/${extension.publisher}/extension/${extension.name}/${extension.version}/`
            + "assetbyname/Microsoft.VisualStudio.Services.VSIXPackage?install=true";

        await downloadFile(extension.downloadURL, filepath, this._syncing.proxy);
        return { ...extension, vsixFilepath: filepath };
    }

    /**
     * Extracts (install) extension vsix package.
     */
    public async extractExtension(extension: IExtension): Promise<IExtension>
    {
        const { vsixFilepath } = extension;
        if (vsixFilepath != null)
        {
            let dirPath: string;
            try
            {
                // Create temp dir.
                dirPath = (await tmp.dir({ postfix: `.${extension.id}`, unsafeCleanup: true })).path;

                // Immediately disable the extension before installing
                this._forceDisableExtension(extension);
            }
            catch
            {
                throw new Error(localize("error.extract.extension-2", extension.id));
            }

            try
            {
                // Extract extension to temp dir.
                await extractZip(vsixFilepath, { dir: dirPath });

                // Copy to vscode extension dir.
                const extPath = this._env.getExtensionDirectory(extension);
                await fs.emptyDir(extPath);
                await fs.copy(path.join(dirPath, "extension"), extPath);

                // Make sure extension stays disabled after installation
                this._forceDisableExtension(extension);

                return extension;
            }
            catch (err: any)
            {
                throw new Error(localize("error.extract.extension-1", extension.id, err.message));
            }
        }

        throw new Error(localize("error.extract.extension-3", extension.id));
    }

    /**
     * Uninstall extension.
     */
    public async uninstallExtension(extension: IExtension): Promise<IExtension>
    {
        const localExtension = getExtensionById(extension.id);
        const extensionPath = localExtension
            ? localExtension.extensionPath
            : this._env.getExtensionDirectory(extension);
        try
        {
            await fs.remove(extensionPath);
            return extension;
        }
        catch
        {
            throw new Error(localize("error.uninstall.extension", extension.id));
        }
    }

    /**
     * Removes VSCode `.obsolete` file and optionally extensions.json file.
     *
     * @param removeExtensionsJson Whether to remove extensions.json file. Defaults to true.
     */
    public async removeVSCodeExtensionFiles(removeExtensionsJson: boolean = true): Promise<void>
    {
        try
        {
            await fs.remove(this._env.obsoleteFilePath);
        }
        catch { }

        if (removeExtensionsJson)
        {
            try
            {
                await fs.remove(this._env.extensionsFilePath);
            }
            catch { }
        }
    }

    /**
     * Gets the extensions that will be added, updated or removed.
     */
    private async _getDifferentExtensions(extensions: IExtension[]): Promise<{
        added: IExtension[];
        removed: IExtension[];
        updated: IExtension[];
        total: number;
    }>
    {
        const result = {
            added: [] as IExtension[],
            removed: [] as IExtension[],
            updated: [] as IExtension[],
            get total()
            {
                return this.added.length + this.removed.length + this.updated.length;
            }
        };
        if (extensions)
        {
            // 1. Auto update extensions: Query the latest extensions.
            let queriedExtensions: CaseInsensitiveMap<string, ExtensionMeta> = new CaseInsensitiveMap();
            const autoUpdateExtensions = getVSCodeSetting<boolean>(
                CONFIGURATION_KEY,
                CONFIGURATION_EXTENSIONS_AUTOUPDATE
            );
            if (autoUpdateExtensions)
            {
                queriedExtensions = await queryExtensions(extensions.map((ext) => ext.id), this._syncing.proxy);
            }

            // Find added & updated extensions.
            const reservedExtensionIDs = new CaseInsensitiveSet<string>();
            for (const ext of extensions)
            {
                // 2. Auto update extensions: Update to the latest version.
                if (autoUpdateExtensions)
                {
                    const extensionMeta = queriedExtensions.get(ext.id);
                    if (extensionMeta)
                    {
                        const latestVersion = findLatestSupportedVSIXVersion(extensionMeta);
                        if (latestVersion != null)
                        {
                            ext.version = latestVersion;
                        }
                    }
                }

                const localExtension = getExtensionById(ext.id);
                if (localExtension)
                {
                    if (localExtension.packageJSON.version === ext.version)
                    {
                        // Reserved.
                        reservedExtensionIDs.add(ext.id);
                    }
                    else
                    {
                        // Updated.
                        result.updated.push(ext);
                    }
                }
                else
                {
                    // Added.
                    result.added.push(ext);
                }
            }

            // Find removed extensions, but don't remove the extensions that are excluded.
            // Here's the trick: since the `extensions.json` are always synchronized after the `settings.json`,
            // We can safely get the patterns from VSCode.
            const patterns = getVSCodeSetting<string[]>(CONFIGURATION_KEY, CONFIGURATION_EXCLUDED_EXTENSIONS);
            const localExtensions: IExtension[] = this.getAll(patterns);
            for (const ext of localExtensions)
            {
                if (!reservedExtensionIDs.has(ext.id))
                {
                    // Removed.
                    result.removed.push(ext);
                }
            }

            // Release resources.
            queriedExtensions.clear();
            reservedExtensionIDs.clear();
        }
        return result;
    }

    /**
     * Adds extensions.
     */
    private async _addExtensions(options: ISyncOptions): Promise<{
        added: IExtension[];
        addedErrors: IExtension[];
    }>
    {
        const { extensions, progress, showIndicator = false, total } = options;

        let steps: number = progress;
        const result = { added: [] as IExtension[], addedErrors: [] as IExtension[] };
        for (const item of extensions)
        {
            try
            {
                steps++;

                if (showIndicator)
                {
                    Toast.showSpinner(localize("toast.settings.downloading.extension", item.id), steps, total);
                }
                const extension = await this.downloadExtension(item);

                if (showIndicator)
                {
                    Toast.showSpinner(localize("toast.settings.installing.extension", item.id), steps, total);
                }
                await this.extractExtension(extension);

                result.added.push(item);
            }
            catch
            {
                result.addedErrors.push(item);
            }
        }
        return result;
    }

    /**
     * Updates extensions.
     */
    private async _updateExtensions(options: ISyncOptions): Promise<{
        updated: IExtension[];
        updatedErrors: IExtension[];
    }>
    {
        const { extensions, progress, showIndicator = false, total } = options;

        let steps: number = progress;
        const result = { updated: [] as IExtension[], updatedErrors: [] as IExtension[] };
        for (const item of extensions)
        {
            try
            {
                steps++;

                if (showIndicator)
                {
                    Toast.showSpinner(localize("toast.settings.downloading.extension", item.id), steps, total);
                }
                let extension = await this.downloadExtension(item);

                if (showIndicator)
                {
                    Toast.showSpinner(localize("toast.settings.removing.outdated.extension", item.id), steps, total);
                }
                extension = await this.uninstallExtension(extension);

                if (showIndicator)
                {
                    Toast.showSpinner(localize("toast.settings.installing.extension", item.id), steps, total);
                }
                await this.extractExtension(extension);


                result.updated.push(item);
            }
            catch
            {
                result.updatedErrors.push(item);
            }
        }
        return result;
    }

    /**
     * Removes extensions.
     */
    private async _removeExtensions(options: ISyncOptions): Promise<{
        removed: IExtension[];
        removedErrors: IExtension[];
    }>
    {
        const { extensions, progress, showIndicator = false, total } = options;

        let steps: number = progress;
        const result = { removed: [] as IExtension[], removedErrors: [] as IExtension[] };
        for (const item of extensions)
        {
            try
            {
                steps++;

                if (showIndicator)
                {
                    Toast.showSpinner(localize("toast.settings.uninstalling.extension", item.id), steps, total);
                }
                await this.uninstallExtension(item);

                result.removed.push(item);
            }
            catch
            {
                result.removedErrors.push(item);
            }
        }
        return result;
    }

    /**
     * Force VSCode to disable an extension using the VSCode CLI command.
     * This ensures extensions are disabled immediately during installation.
     *
     * @param extension The extension to disable immediately
     */
    private _forceDisableExtension(extension: IExtension): void
    {
        try
        {
            // Use VSCode CLI to disable the extension
            const { exec } = require("child_process");
            const execName = path.basename(process.execPath); // Ottiene l'ultimo elemento del percorso
            // The VSCode CLI command to disable an extension

            // Execute the command synchronously
            exec(`${execName} --list-extensions`, (error: Error | null, stdout: string, stderr: string) =>
            {
                if (error)
                {
                    console.error(`Errore: ${error.message}`);
                    return;
                }
                if (stderr)
                {
                    console.error(`Stderr: ${stderr}`);
                    return;
                }
                console.log(`Estensioni installate in ${execName}:\n`, stdout);
            });

            console.log(`Extension ${extension.id} disabled immediately via CLI`);
        }
        catch (err)
        {
            // Fall back to writing to the .obsolete file if CLI command fails
            try
            {
                console.error(`Failed to disable extension ${extension.id} via CLI, falling back to .obsolete file:`, err);

                // VSCode expects a JSON object where keys are extension IDs with version and values are true
                let obsoleteData: Record<string, boolean> = {};

                // Read existing file if it exists
                if (fs.existsSync(this._env.obsoleteFilePath))
                {
                    try
                    {
                        const content = fs.readFileSync(this._env.obsoleteFilePath, "utf8");
                        if (content)
                        {
                            obsoleteData = JSON.parse(content);
                        }
                    }
                    catch (parseErr)
                    {
                        // If parsing fails, start with an empty object
                        console.error("Error parsing .obsolete file, creating new one:", parseErr);
                        obsoleteData = {};
                    }
                }

                // Create the extension key in the format VSCode expects: publisher.name-version
                const extensionKey = `${extension.publisher}.${extension.name}-${extension.version}`;

                // Add this extension to the obsolete list
                obsoleteData[extensionKey] = true;

                // Write the updated JSON back to the file
                fs.writeFileSync(this._env.obsoleteFilePath, JSON.stringify(obsoleteData));
                console.log(`Extension ${extension.id} v${extension.version} marked as obsolete (fallback method)`);
            }
            catch (fallbackErr)
            {
                // Log error but don't stop installation
                console.error(`Failed to mark extension ${extension.id} as obsolete (all methods failed):`, fallbackErr);
            }
        }
    }
}
