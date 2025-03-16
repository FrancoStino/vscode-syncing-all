/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
import * as fs from "fs-extra";

import { Environment } from "./Environment";
import { GoogleDriveAdapter } from "./GoogleDriveAdapter";
import { GoogleDrive } from "./GoogleDrive";
import { isEmptyString } from "../utils/lang";
import { localize } from "../i18n";
import { normalizeHttpProxy } from "../utils/normalizer";
import { openFile } from "../utils/vscodeAPI";
import * as Toast from "./Toast";
import { StorageProvider, SettingType } from "../types";
import {
    DEFAULT_STORAGE_PROVIDER,
    DEFAULT_GOOGLE_CLIENT_ID,
    DEFAULT_GOOGLE_CLIENT_SECRET
} from "../constants";
import type { ISyncingSettings } from "../types";
import type { ISetting } from "../types";

/**
 * `Syncing` wrapper.
 */
export class Syncing
{
    private static _instance: Syncing;

    /**
     * The default settings of `Syncing`.
     */
    private static readonly _DEFAULT_SETTINGS: ISyncingSettings = {
        id: "",
        token: "",
        http_proxy: "",
        auto_sync: false,
        storage_provider: StorageProvider.GoogleDrive,
        google_client_id: DEFAULT_GOOGLE_CLIENT_ID,
        google_client_secret: DEFAULT_GOOGLE_CLIENT_SECRET
    };

    private _env: Environment;
    private _settingsPath: string;

    // Track the last requested operation
    private _lastRequestedOperation: "upload" | "download" | null = null;

    private constructor()
    {
        this._env = Environment.create();
        this._settingsPath = this._env.getSettingsFilePath("syncing.json");
    }

    /**
     * Creates an instance of singleton class `Syncing`.
     */
    public static create(): Syncing
    {
        if (!Syncing._instance)
        {
            Syncing._instance = new Syncing();
        }
        return Syncing._instance;
    }

    /**
     * Gets the full path of `Syncing`'s `settings file`.
     */
    public get settingsPath(): string
    {
        return this._settingsPath;
    }

    /**
     * Gets the proxy setting of `Syncing`.
     *
     * If the proxy setting is not set, it will read from the `http_proxy` and `https_proxy` environment variables.
     */
    public get proxy(): string | undefined
    {
        return this.loadSettings().http_proxy;
    }

    /**
     * Gets the auto-sync setting of `Syncing`.
     *
     * @default false
     */
    public get autoSync(): boolean
    {
        return this.loadSettings().auto_sync;
    }

    /**
     * Gets the storage provider setting of `Syncing`.
     */
    public get storageProvider(): StorageProvider
    {
        return this.loadSettings().storage_provider ?? StorageProvider.GoogleDrive;
    }

    /**
     * Gets the Remote Storage client.
     */
    public getRemoteStorageClient(): GoogleDriveAdapter
    {
        const settings = this.loadSettings();
        return GoogleDriveAdapter.create(settings.token, settings.http_proxy);
    }

    /**
     * Gets the Google Drive client.
     */
    public getGoogleDriveClient(): GoogleDrive
    {
        const settings = this.loadSettings();
        return GoogleDrive.create(
            settings.google_client_id ?? DEFAULT_GOOGLE_CLIENT_ID,
            settings.google_client_secret ?? DEFAULT_GOOGLE_CLIENT_SECRET,
            settings.google_refresh_token,
            settings.id
        );
    }

    /**
     * Sets the last requested operation (upload or download)
     * @param operation The operation type
     */
    public setLastRequestedOperation(operation: "upload" | "download"): void
    {
        this._lastRequestedOperation = operation;
    }

    /**
     * Gets the last requested operation
     * @returns The last requested operation or null if none
     */
    public getLastRequestedOperation(): "upload" | "download" | null
    {
        return this._lastRequestedOperation;
    }

    /**
     * Init the `Syncing`'s settings file.
     */
    public async initSettings(): Promise<void>
    {
        // Check if the settings file already exists
        const fileExists = await fs.pathExists(this._settingsPath);

        if (fileExists)
        {
            // If file exists, load and validate it instead of overwriting
            try
            {
                const currentSettings = this.loadSettings();

                // Only initialize if the settings are incomplete/invalid
                if (!currentSettings.storage_provider)
                {
                    // Set default storage provider while preserving other settings
                    currentSettings.storage_provider = DEFAULT_STORAGE_PROVIDER;
                    return this.saveSettings(currentSettings);
                }

                // Settings are valid, no need to initialize
                return;
            }
            catch (err)
            {
                console.error("Failed to load existing settings, will initialize with defaults", err);
                // Continue to initialization if loading fails
            }
        }

        // Initialize with default settings if file doesn't exist or is invalid
        return this.saveSettings(Syncing._DEFAULT_SETTINGS);
    }

    /**
     * Clears the personal access token and save to `Syncing`'s settings file.
     */
    public clearToken(): Promise<void>
    {
        const settings: ISyncingSettings = this.loadSettings();
        settings.token = "";
        return this.saveSettings(settings);
    }

    /**
     * Clears the remote storage ID and save to `Syncing`'s settings file.
     */
    public clearStorageID(): Promise<void>
    {
        const settings: ISyncingSettings = this.loadSettings();
        settings.id = "";
        return this.saveSettings(settings);
    }

    /**
     * Prepares the `Syncing`'s settings for uploading.
     *
     * @param showIndicator Whether to show the progress indicator. Defaults to `false`.
     */
    public prepareUploadSettings(showIndicator: boolean = false): Promise<ISyncingSettings>
    {
        // Access token must exist, but storage ID could be none.
        return this.prepareSettings(true, showIndicator);
    }

    /**
     * Prepares the `Syncing`'s settings for downloading.
     *
     * @param showIndicator Whether to show the progress indicator. Defaults to `false`.
     */
    public prepareDownloadSettings(showIndicator: boolean = false): Promise<ISyncingSettings>
    {
        // Access token could be none, but storage ID must exist.
        return this.prepareSettings(false, showIndicator);
    }

    /**
     * Prepare `Syncing`'s settings, will ask for settings if the settings are not existed.
     *
     * @param _forUpload Whether to show messages for upload. Defaults to `true`.
     * @param showIndicator Whether to show the progress indicator. Defaults to `false`.
     */
    public async prepareSettings(_forUpload: boolean = true, showIndicator: boolean = false): Promise<ISyncingSettings>
    {
        try
        {
            const settings = this.loadSettings();

            // Always set Google Drive as the provider
            settings.storage_provider = StorageProvider.GoogleDrive;

            // Handle Google Drive credentials
            if (settings.storage_provider === StorageProvider.GoogleDrive)
            {
                // If there are no credentials, use the default ones
                if (!settings.google_client_id || !settings.google_client_secret)
                {
                    settings.google_client_id = DEFAULT_GOOGLE_CLIENT_ID;
                    settings.google_client_secret = DEFAULT_GOOGLE_CLIENT_SECRET;
                }

                // If there is no refresh token, authentication will be handled by GoogleDrive
                // If there is no folder ID, selection will be handled by GoogleDrive
            }

            await this.saveSettings(settings, true);

            if (showIndicator)
            {
                Toast.statusInfo(localize("toast.settings.prepared"));
            }

            return settings;
        }
        catch (err)
        {
            if (showIndicator)
            {
                Toast.statusError(err.message);
            }
            throw err;
        }
    }

    /**
     * Loads the `Syncing`'s settings from the settings file (`syncing.json`) and environment variables.
     */
    public loadSettings(): ISyncingSettings
    {
        let settings: ISyncingSettings = { ...Syncing._DEFAULT_SETTINGS };
        try
        {
            settings = {
                ...settings,
                ...fs.readJsonSync(this.settingsPath, { encoding: "utf8" })
            };
        }
        catch (err: any)
        {
            console.error(localize("error.loading.syncing.settings"), err);
        }

        // Read proxy setting from environment variables.
        // Note that the proxy will eventually be normalized to either `undefined` or a correct string value.
        let proxy = settings.http_proxy;
        if (proxy == null || isEmptyString(proxy))
        {
            proxy = process.env["http_proxy"] || process.env["https_proxy"];
        }

        return { ...settings, http_proxy: normalizeHttpProxy(proxy) };
    }

    /**
     * Open `Syncing`'s settings file in a VSCode editor.
     */
    public async openSettings()
    {
        const exists = await fs.pathExists(this.settingsPath);
        if (!exists)
        {
            await this.initSettings();
        }
        openFile(this.settingsPath);
    }

    /**
     * Save `Syncing`'s settings to disk.
     *
     * @param settings Syncing's Settings.
     * @param showToast Whether to show error toast. Defaults to `false`.
     */
    public async saveSettings(settings: ISyncingSettings, showToast: boolean = false): Promise<void>
    {
        const target = { ...settings };

        // Normalize null proxy to an empty string.
        if (target.http_proxy == null)
        {
            target.http_proxy = "";
        }

        // Never save client ID and secret in the syncing.json file
        delete target.google_client_id;
        delete target.google_client_secret;

        const content = JSON.stringify(target, null, 4);
        try
        {
            await fs.outputFile(this.settingsPath, content);
        }
        catch (err: any)
        {
            if (showToast)
            {
                Toast.statusError(localize("toast.syncing.save.settings", err));
            }
        }
    }

    /**
     * Restore a specific file revision from Google Drive
     *
     * @param fileId ID of the file to restore
     * @param revisionId ID of the revision to restore
     * @param filename Name of the file
     */
    public async restoreFileRevision(fileId: string, revisionId: string, filename: string): Promise<void>
    {
        const googleDrive = this.getGoogleDriveClient();

        try
        {
            // Download the revision content
            const content = await googleDrive.downloadFileRevision(fileId, revisionId);

            // Create a setting object for upload
            const setting: ISetting = {
                type: SettingType.Settings, // This is a default, will be overridden below
                remoteFilename: filename,
                localFilePath: filename,
                content
            };

            // Detect the setting type based on the filename
            if (filename === "extensions.json")
            {
                setting.type = SettingType.Extensions;
            }
            else if (filename === "state.vscdb")
            {
                setting.type = SettingType.StateDB;
            }
            else if (filename.endsWith(".json"))
            {
                if (filename.includes("keybindings"))
                {
                    setting.type = SettingType.Keybindings;
                }
                else if (filename.includes("snippets"))
                {
                    setting.type = SettingType.Snippets;
                }
                else
                {
                    setting.type = SettingType.Settings;
                }
            }

            // Upload the revision content as the current version (overwriting)
            await googleDrive.uploadSettings(setting);

            return;
        }
        catch (error: any)
        {
            console.error("Error restoring file revision:", error);
            throw error;
        }
    }

    /**
     * Restore all settings from a specific date
     *
     * @param date Date string in local format to restore from
     */
    public async restoreSettingsFromDate(date: string): Promise<{ success: boolean; restoredFiles: string[] }>
    {
        const googleDrive = this.getGoogleDriveClient();
        const restoredFiles: string[] = [];

        try
        {
            // Get all files in the Google Drive folder
            const fileMap = await googleDrive.getAllFileIds();
            console.log("Restoring settings from date:", date);

            // Check that the selected date is valid
            let selectedDate: Date;
            try
            {
                selectedDate = this._parseLocalizedDate(date);
                console.log("Converted date:", selectedDate.toISOString());
            }
            catch (dateError)
            {
                console.error("Error converting date:", dateError);
                throw new Error("Unable to process the selected date");
            }

            // For each file, find the revision closest to the selected date
            for (const [filename, fileId] of fileMap.entries())
            {
                try
                {
                    console.log(`Processing file: ${filename} (ID: ${fileId})`);

                    // Get all revisions of the file
                    const revisions = await googleDrive.getFileRevisions(fileId);
                    console.log(`Found ${revisions.length} revisions for ${filename}`);

                    if (revisions.length === 0)
                    {
                        continue; // Skip if no revisions found
                    }

                    // Find the most recent revision not after the selected date
                    let closestRevision: { id: string; modifiedTime: string } | null = null;

                    for (const revision of revisions)
                    {
                        try
                        {
                            if (!revision.modifiedTime)
                            {
                                console.log("Revision without modifiedTime, skipped");
                                continue;
                            }

                            const revisionDate = this._parseLocalizedDate(revision.modifiedTime);
                            console.log(`Comparing revision date: ${revisionDate.toLocaleDateString()} with selected: ${selectedDate.toLocaleDateString()}`);

                            // Check if this revision's date matches the selected date (just the date part)
                            if (revisionDate.toLocaleDateString() === selectedDate.toLocaleDateString())
                            {
                                console.log("Matching date found");

                                if (!closestRevision ||
                                    this._parseLocalizedDate(revision.modifiedTime).getTime() >
                                    this._parseLocalizedDate(closestRevision.modifiedTime).getTime())
                                {
                                    closestRevision = revision;
                                    console.log("Updated most recent revision");
                                }
                            }
                        }
                        catch (revError)
                        {
                            console.error("Error processing revision:", revError);
                        }
                    }

                    // If we found a revision for this date, restore it
                    if (closestRevision)
                    {
                        console.log(`Restoring revision ${closestRevision.id} for file ${filename}`);
                        await this.restoreFileRevision(fileId, closestRevision.id, filename);
                        restoredFiles.push(filename);
                    }
                    else
                    {
                        console.log(`No revision found for the selected date for file ${filename}`);
                    }
                }
                catch (fileError)
                {
                    console.error(`Error processing file ${filename} during date restore:`, fileError);
                    // Continue with other files
                }
            }

            return {
                success: restoredFiles.length > 0,
                restoredFiles
            };
        }
        catch (error: any)
        {
            console.error("Error restoring settings from date:", error);
            throw error;
        }
    }

    /**
     * Parses a localized date string into a Date object.
     * @param dateStr The date string to parse
     * @returns A Date object
     */
    private _parseLocalizedDate(dateStr: string): Date
    {
        // Check if the date is in Italian format (DD/MM/YYYY, HH:MM:SS)
        const italianDateRegex = /(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/;
        const match = dateStr.match(italianDateRegex);

        if (match)
        {
            // Extract date components from the match
            const day = parseInt(match[1], 10);
            const month = parseInt(match[2], 10) - 1; // Months in JS are 0-indexed
            const year = parseInt(match[3], 10);
            const hour = parseInt(match[4], 10);
            const minute = parseInt(match[5], 10);
            const second = parseInt(match[6], 10);

            // Create a valid date using the numeric components
            const date = new Date(year, month, day, hour, minute, second);
            console.log(`Date converted from ${dateStr} to ${date.toISOString()}`);
            return date;
        }

        // Also check Italian format without time
        const simpleDateRegex = /(\d{1,2})\/(\d{1,2})\/(\d{4})/;
        const simpleMatch = dateStr.match(simpleDateRegex);

        if (simpleMatch)
        {
            // Extract date components from the simple match
            const day = parseInt(simpleMatch[1], 10);
            const month = parseInt(simpleMatch[2], 10) - 1; // Months in JS are 0-indexed
            const year = parseInt(simpleMatch[3], 10);

            // Create a valid date using the numeric components
            const date = new Date(year, month, day);
            console.log(`Simple date converted from ${dateStr} to ${date.toISOString()}`);
            return date;
        }

        // If not in Italian format, try the standard JS parser
        const date = new Date(dateStr);

        // Verify that the date is valid
        if (isNaN(date.getTime()))
        {
            console.error(`Unable to parse date: ${dateStr}`);
            // Return current date as fallback
            return new Date();
        }

        return date;
    }
}
