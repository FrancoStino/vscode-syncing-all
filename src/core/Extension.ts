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
interface ISyncOptions {
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
export class Extension {
    private static _instance: Extension;

    private _env: Environment;
    private _syncing: Syncing;

    private constructor() {
        this._env = Environment.create();
        this._syncing = Syncing.create();
    }

    /**
     * Creates an instance of the singleton class `Extension`.
     */
    public static create(): Extension {
        if (!Extension._instance) {
            Extension._instance = new Extension();
        }
        return Extension._instance;
    }

    /**
     * Gets all installed extensions including disabled ones.
     *
     * @param excludedPatterns The glob patterns of the extensions that should be excluded.
     */
    public getAll(excludedPatterns: string[] = []): IExtension[] {
        const result: IExtension[] = [];
        let totalExtensions = 0;
        let skippedBuiltin = 0;
        let skippedExcluded = 0;

        try {
            // Check if extensions.json exists
            if (fs.existsSync(this._env.extensionsFilePath)) {
                // Read and parse extensions.json
                const extensionsJson = fs.readJSONSync(this._env.extensionsFilePath);

                // Add the current extension to excluded patterns
                excludedPatterns.push("DavideLadisa.sync-all-settings");

                // Process extensions array based on structure from jq command:
                // .[] | .identifier.id + " (v" + .version + ")"
                if (Array.isArray(extensionsJson)) {
                    totalExtensions = extensionsJson.length;
                    for (const ext of extensionsJson) {
                        if (ext && ext.identifier && ext.identifier.id) {
                            const id = ext.identifier.id;
                            const version = ext.version || "0.0.0"; // Default version if not specified

                            // Skip VSCode built-in extensions
                            if (id.startsWith("vscode.")) {
                                skippedBuiltin++;
                                continue;
                            }

                            // Apply excluded patterns filter
                            if (excludedPatterns.some((pattern) => micromatch.isMatch(id, pattern, { nocase: true }))) {
                                skippedExcluded++;
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
        catch (error) {
            // Log error using proper logging mechanism
            this._logError("Error reading extensions.json:", error);
        }

        // Log statistics using proper logging mechanism
        this._logInfo("Extensions statistics:", {
            totalExtensions,
            skippedBuiltin,
            skippedExcluded,
            finalCount: result.length
        });

        return result.sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
    }

    /**
     * Synchronize extensions (add, update or remove).
     *
     * @param extensions Extensions to be synced.
     * @param showIndicator Whether to show the progress indicator. Defaults to `false`.
     */
    public async sync(extensions: IExtension[], showIndicator: boolean = false): Promise<ISyncedItem> {
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

        for (const task of tasks) {
            const value = await task();
            Object.assign(result.extension, value);
        }

        if (showIndicator) {
            Toast.clearSpinner("");
        }

        // Added since VSCode v1.20.
        await this.removeVSCodeExtensionFiles();

        // Disable all extensions at the end of the process
        for (const ext of extensions) {
            this._forceDisableExtension(ext);
        }

        // Replace state.vscdb with the one from Google Drive
        if (this.hasStateDB()) {
            await this.replaceStateDB(this.getStateDBPath());
        }

        return result as ISyncedItem;
    }

    /**
     * Downloads extension from VSCode marketplace.
     */
    public async downloadExtension(extension: IExtension): Promise<IExtension> {
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
     * Gets the path to the state.vscdb file
     */
    public getStateDBPath(): string {
        const env = Environment.create();
        return env.stateDBPath;
    }

    /**
     * Checks if state.vscdb exists
     */
    public hasStateDB(): boolean {
        return fs.existsSync(this.getStateDBPath());
    }

    /**
     * Replaces the current state.vscdb with the one from Google Drive
     * @param googleDriveStateDBPath Path to the state.vscdb file from Google Drive
     */
    public async replaceStateDB(googleDriveStateDBPath: string): Promise<void> {
        try {
            const currentStateDBPath = this.getStateDBPath();
            this._logInfo(`Attempting to replace state.vscdb from ${googleDriveStateDBPath} to ${currentStateDBPath}`);

            // Create a backup of the current state.vscdb if it exists
            if (this.hasStateDB()) {
                const backupPath = `${currentStateDBPath}.backup`;
                await fs.copy(currentStateDBPath, backupPath);
                this._logInfo(`Created backup of state.vscdb at ${backupPath}`);
            }
            else {
                this._logInfo(`No existing state.vscdb found at ${currentStateDBPath}`);
            }

            try {
                // Ensure directory exists
                await fs.ensureDir(path.dirname(currentStateDBPath));
                this._logInfo(`Ensured directory exists: ${path.dirname(currentStateDBPath)}`);

                // Read the content of the Google Drive file - handle both binary and base64 encoded files
                let driveContent;
                try {
                    // First try to read as binary file
                    driveContent = await fs.readFile(googleDriveStateDBPath);
                    this._logInfo(`Read ${driveContent.length} bytes from Google Drive state.vscdb`);

                    // Check if the content might be base64 encoded
                    const contentAsString = driveContent.toString("utf8");
                    if (contentAsString.match(/^[A-Za-z0-9+/=]+$/)) {
                        try {
                            // Try to decode it as base64
                            const decoded = Buffer.from(contentAsString, "base64");
                            driveContent = decoded;
                            this._logInfo(`Detected and decoded base64 encoded state.vscdb file (${decoded.length} bytes)`);
                        }
                        catch (err) {
                            // If decoding fails, use the original binary
                            this._logInfo(`Content appears to be base64 but decoding failed, using as binary: ${err.message}`);
                        }
                    }
                }
                catch (err) {
                    this._logError(`Error reading Google Drive state.vscdb: ${err.message}`);
                    throw err;
                }

                // First try to remove the existing file if it exists
                if (fs.existsSync(currentStateDBPath)) {
                    try {
                        await fs.remove(currentStateDBPath);
                        this._logInfo(`Removed existing state.vscdb file before writing new one`);
                    } catch (removeErr) {
                        this._logError(`Error removing existing state.vscdb: ${removeErr.message}`);
                        // Continue anyway and try to write
                    }
                }

                // Write the content directly to the current file
                await fs.writeFile(currentStateDBPath, driveContent);

                // Verify the file was written successfully
                if (fs.existsSync(currentStateDBPath)) {
                    const stats = await fs.stat(currentStateDBPath);
                    this._logInfo(`Successfully replaced state.vscdb with version from Google Drive (size: ${stats.size} bytes)`);
                } else {
                    throw new Error("File was not written successfully - file doesn't exist after write operation");
                }

                // Remove the backup if everything succeeded
                const backupPath = `${currentStateDBPath}.backup`;
                if (fs.existsSync(backupPath)) {
                    await fs.remove(backupPath);
                    this._logInfo(`Removed backup after successful replacement`);
                }
            }
            catch (error) {
                // If operation fails, restore from backup if it exists
                const backupPath = `${currentStateDBPath}.backup`;
                if (fs.existsSync(backupPath)) {
                    await fs.copy(backupPath, currentStateDBPath);
                    await fs.remove(backupPath);
                    this._logInfo("Restored state.vscdb from backup after failed replacement");
                } else {
                    this._logError(`No backup available to restore from after error: ${error.message}`);
                }
                throw error;
            }
        }
        catch (error) {
            this._logError("Failed to replace state.vscdb:", error);
            throw error;
        }
    }

    /**
     * Extracts (install) extension vsix package.
     */
    public async extractExtension(extension: IExtension): Promise<IExtension> {
        const { vsixFilepath } = extension;
        if (vsixFilepath != null) {
            let dirPath: string;
            try {
                // Create temp dir.
                dirPath = (await tmp.dir({ postfix: `.${extension.id}`, unsafeCleanup: true })).path;

                // Immediately disable the extension before installing
                this._forceDisableExtension(extension);
            }
            catch {
                throw new Error(localize("error.extract.extension-2", extension.id));
            }

            try {
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
            catch (error: any) {
                throw new Error(localize("error.extract.extension-1", extension.id, error.message));
            }
        }

        throw new Error(localize("error.extract.extension-3", extension.id));
    }

    /**
     * Uninstall extension.
     */
    public async uninstallExtension(extension: IExtension): Promise<IExtension> {
        const localExtension = getExtensionById(extension.id);
        const extensionPath = localExtension
            ? localExtension.extensionPath
            : this._env.getExtensionDirectory(extension);
        try {
            await fs.remove(extensionPath);
            return extension;
        }
        catch {
            throw new Error(localize("error.uninstall.extension", extension.id));
        }
    }

    /**
     * Removes VSCode `.obsolete` file and optionally extensions.json file.
     *
     * @param removeExtensionsJson Whether to remove extensions.json file. Defaults to true.
     */
    public async removeVSCodeExtensionFiles(removeExtensionsJson: boolean = true): Promise<void> {
        try {
            await fs.remove(this._env.obsoleteFilePath);
        }
        catch { }

        if (removeExtensionsJson) {
            try {
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
    }> {
        const result = {
            added: [] as IExtension[],
            removed: [] as IExtension[],
            updated: [] as IExtension[],
            get total() {
                return this.added.length + this.removed.length + this.updated.length;
            }
        };
        if (extensions) {
            // 1. Auto update extensions: Query the latest extensions.
            let queriedExtensions: CaseInsensitiveMap<string, ExtensionMeta> = new CaseInsensitiveMap();
            const autoUpdateExtensions = getVSCodeSetting<boolean>(
                CONFIGURATION_KEY,
                CONFIGURATION_EXTENSIONS_AUTOUPDATE
            );
            if (autoUpdateExtensions) {
                queriedExtensions = await queryExtensions(extensions.map((ext) => ext.id), this._syncing.proxy);
            }

            // Find added & updated extensions.
            const reservedExtensionIDs = new CaseInsensitiveSet<string>();
            for (const ext of extensions) {
                // 2. Auto update extensions: Update to the latest version.
                if (autoUpdateExtensions) {
                    const extensionMeta = queriedExtensions.get(ext.id);
                    if (extensionMeta) {
                        const latestVersion = findLatestSupportedVSIXVersion(extensionMeta);
                        if (latestVersion != null) {
                            ext.version = latestVersion;
                        }
                    }
                }

                const localExtension = getExtensionById(ext.id);
                if (localExtension) {
                    if (localExtension.packageJSON.version === ext.version) {
                        // Reserved.
                        reservedExtensionIDs.add(ext.id);
                    }
                    else {
                        // Updated.
                        result.updated.push(ext);
                    }
                }
                else {
                    // Added.
                    result.added.push(ext);
                }
            }

            // Find removed extensions, but don't remove the extensions that are excluded.
            // Here's the trick: since the `extensions.json` are always synchronized after the `settings.json`,
            // We can safely get the patterns from VSCode.
            const patterns = getVSCodeSetting<string[]>(CONFIGURATION_KEY, CONFIGURATION_EXCLUDED_EXTENSIONS);
            const localExtensions: IExtension[] = this.getAll(patterns);
            for (const ext of localExtensions) {
                if (!reservedExtensionIDs.has(ext.id)) {
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
    }> {
        const { extensions, progress, showIndicator = false, total } = options;

        let steps: number = progress;
        const result = { added: [] as IExtension[], addedErrors: [] as IExtension[] };
        for (const item of extensions) {
            try {
                steps++;

                if (showIndicator) {
                    Toast.showSpinner(localize("toast.settings.downloading.extension", item.id), steps, total);
                }
                const extension = await this.downloadExtension(item);

                if (showIndicator) {
                    Toast.showSpinner(localize("toast.settings.installing.extension", item.id), steps, total);
                }
                await this.extractExtension(extension);

                result.added.push(item);
            }
            catch {
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
    }> {
        const { extensions, progress, showIndicator = false, total } = options;

        let steps: number = progress;
        const result = { updated: [] as IExtension[], updatedErrors: [] as IExtension[] };
        for (const item of extensions) {
            try {
                steps++;

                if (showIndicator) {
                    Toast.showSpinner(localize("toast.settings.downloading.extension", item.id), steps, total);
                }
                let extension = await this.downloadExtension(item);

                if (showIndicator) {
                    Toast.showSpinner(localize("toast.settings.removing.outdated.extension", item.id), steps, total);
                }
                extension = await this.uninstallExtension(extension);

                if (showIndicator) {
                    Toast.showSpinner(localize("toast.settings.installing.extension", item.id), steps, total);
                }
                await this.extractExtension(extension);

                result.updated.push(item);
            }
            catch {
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
    }> {
        const { extensions, progress, showIndicator = false, total } = options;

        let steps: number = progress;
        const result = { removed: [] as IExtension[], removedErrors: [] as IExtension[] };
        for (const item of extensions) {
            try {
                steps++;

                if (showIndicator) {
                    Toast.showSpinner(localize("toast.settings.uninstalling.extension", item.id), steps, total);
                }
                await this.uninstallExtension(item);

                result.removed.push(item);
            }
            catch {
                result.removedErrors.push(item);
            }
        }
        return result;
    }

    /**
     * Force VSCode to disable an extension by modifying state.vscdb.
     * This ensures extensions are disabled immediately during installation.
     *
     * @param extension The extension to disable immediately
     */
    private _forceDisableExtension(extension: IExtension): void {
        try {
            const env = Environment.create();
            const stateDBPath = env.stateDBPath;

            if (!fs.existsSync(stateDBPath)) {
                this._logInfo(`SQLite: state.vscdb file not found at ${stateDBPath}, skipping immediate disable`);
                return;
            }

            // Log only - no error shown to the user
            this._logInfo(`Marking extension ${extension.id} as disabled. Actual disabling will happen at next VSCode restart.`);

            // Verifico se è possibile evitare completamente la dipendenza da SQLite
            try {
                // Verifico se posso importare sqlite3
                let sqlite3 = null;
                try {
                    sqlite3 = require("sqlite3");
                }
                catch (e) {
                    this._logInfo("SQLite: Module not available in this environment, extension will be disabled at next restart");
                    return; // Esci silenziosamente se sqlite3 non è disponibile
                }

                // Verifico se Database è un costruttore valido
                if (!sqlite3 || typeof sqlite3.Database !== "function") {
                    this._logInfo("SQLite: Database constructor not available, extension will be disabled at next restart");
                    return; // Esci silenziosamente se Database non è un costruttore
                }

                // Creo una copia temporanea del database
                const tempDBPath = `${stateDBPath}.temp`;
                fs.copyFileSync(stateDBPath, tempDBPath);

                // Tento l'operazione
                const db = new sqlite3.Database(tempDBPath);

                // First, try to get existing disabled extensions
                db.get("SELECT value FROM ItemTable WHERE key = 'extensionsIdentifiers/disabled'", (dbError: any, row: any) => {
                    if (dbError) {
                        this._logInfo(`SQLite: Error reading disabled extensions: ${dbError.message}`);
                        db.close();
                        fs.unlinkSync(tempDBPath);
                        return;
                    }

                    let disabledExtensions: string[] = [];
                    if (row && row.value) {
                        try {
                            disabledExtensions = JSON.parse(row.value);
                            if (!Array.isArray(disabledExtensions)) {
                                disabledExtensions = [];
                            }
                        }
                        catch (parseError) {
                            this._logInfo(`SQLite: Error parsing disabled extensions: ${(parseError as Error).message}`);
                            disabledExtensions = [];
                        }
                    }

                    // Add the new extension if not already present
                    const extensionId = `${extension.publisher}.${extension.name}`;
                    if (extensionId && !disabledExtensions.includes(extensionId)) {
                        disabledExtensions.push(extensionId);
                    }

                    // Update or insert the disabled extensions
                    const value = JSON.stringify(disabledExtensions);
                    db.run(
                        "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)",
                        ["extensionsIdentifiers/disabled", value],
                        (updateError: any) => {
                            if (updateError) {
                                this._logInfo(`SQLite: Error updating disabled extensions: ${updateError.message}`);
                                db.close();
                                fs.unlinkSync(tempDBPath);
                                return;
                            }

                            // Close the database connection
                            db.close((closeError: any) => {
                                if (closeError) {
                                    this._logInfo(`SQLite: Error closing database: ${closeError.message}`);
                                    if (fs.existsSync(tempDBPath)) {
                                        fs.unlinkSync(tempDBPath);
                                    }
                                    return;
                                }

                                // Replace the original database with the modified one
                                try {
                                    fs.renameSync(stateDBPath, `${stateDBPath}.backup`);
                                    fs.renameSync(tempDBPath, stateDBPath);
                                    this._logInfo(`SQLite: Extension ${extension.id} immediately disabled in state.vscdb`);
                                    // Remove backup after successful operation
                                    fs.unlinkSync(`${stateDBPath}.backup`);
                                }
                                catch (fsError) {
                                    this._logInfo(`SQLite: Error replacing database file: ${(fsError as Error).message}`);
                                    // Try to restore from backup if it exists
                                    if (fs.existsSync(`${stateDBPath}.backup`)) {
                                        fs.renameSync(`${stateDBPath}.backup`, stateDBPath);
                                    }
                                }
                            });
                        }
                    );
                });
            }
            catch (dbError) {
                // Ignora l'errore, le estensioni verranno disabilitate al prossimo riavvio di VSCode
                this._logInfo(`SQLite: Database operation could not be completed: ${(dbError as Error).message}`);
                // Nessun messaggio di errore mostrato all'utente, l'operazione è opzionale
            }
        }
        catch (error) {
            // Ignora qualsiasi errore, le estensioni verranno disabilitate al prossimo riavvio di VSCode
            this._logInfo(`Fallback disable: Extension ${extension.id} will be disabled at next VSCode restart`);
            // Nessun messaggio di errore mostrato all'utente, l'operazione è opzionale
        }
    }

    /**
     * Logs an error message with optional error object
     */
    private _logError(message: string, error?: any): void {
        // TODO: Replace with proper logging mechanism
        console.error(message, error || "");
    }

    /**
     * Logs an info message with optional data object
     */
    private _logInfo(message: string, data?: any): void {
        // TODO: Replace with proper logging mechanism
        console.log(message, data || "");
    }
}
