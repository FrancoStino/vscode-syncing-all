/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
import * as fs from "fs-extra";

import { Environment } from "./Environment";
import { Gist } from "./Gist";
import { GoogleDrive } from "./GoogleDrive";
import { isEmptyString } from "../utils/lang";
import { localize } from "../i18n";
import { normalizeHttpProxy } from "../utils/normalizer";
import { openFile } from "../utils/vscodeAPI";
import * as Toast from "./Toast";
import { StorageProvider } from "../types";
import {
    DEFAULT_STORAGE_PROVIDER,
    DEFAULT_GOOGLE_CLIENT_ID,
    DEFAULT_GOOGLE_CLIENT_SECRET
} from "../constants";
import type { ISyncingSettings } from "../types";

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
        return this.loadSettings().storage_provider ?? StorageProvider.GitHubGist;
    }

    /**
     * Gets the Remote Storage client.
     */
    public getRemoteStorageClient(): Gist
    {
        const settings = this.loadSettings();
        return Gist.create(settings.token, settings.http_proxy);
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
     * @param forUpload Whether to show messages for upload. Defaults to `true`.
     * @param showIndicator Whether to show the progress indicator. Defaults to `false`.
     */
    public async prepareSettings(forUpload: boolean = true, showIndicator: boolean = false): Promise<ISyncingSettings>
    {
        if (showIndicator)
        {
            Toast.showSpinner(localize("toast.syncing.checking.settings"));
        }

        try
        {
            const settings: ISyncingSettings = this.loadSettings();
            settings.token = settings.token || "";
            settings.id = settings.id || "";

            // Skip access token request if using Google Drive
            if (settings.storage_provider === StorageProvider.GoogleDrive)
            {
                // Check if Google credentials are missing but considering defaults
                const hasGoogleClientId = settings.google_client_id || DEFAULT_GOOGLE_CLIENT_ID;
                const hasGoogleClientSecret = settings.google_client_secret || DEFAULT_GOOGLE_CLIENT_SECRET;
                const isMissingGoogleCredentials = !hasGoogleClientId || !hasGoogleClientSecret;

                if (isMissingGoogleCredentials)
                {
                    // Show a helpful error message with instructions instead of resetting
                    if (showIndicator)
                    {
                        Toast.clearSpinner("");
                    }

                    throw new Error(localize("error.missing.google.credentials.instructions"));
                }

                // For Google Drive, we only need to check if ID is empty for downloading
                if ((settings.id == null || isEmptyString(settings.id)) && !forUpload)
                {
                    throw new Error(localize("error.check.folder.id"));
                }

                // If we're missing the refresh token, we should initiate the authentication flow
                if (!settings.google_refresh_token)
                {
                    // Get Google Drive client to initiate authentication
                    const googleDrive = this.getGoogleDriveClient();

                    // Start authentication process by opening the browser
                    await googleDrive.authenticate();

                    // After authentication, get the refresh token and save it to settings
                    if (googleDrive.refreshToken)
                    {
                        settings.google_refresh_token = googleDrive.refreshToken;
                        await this.saveSettings(settings, true);

                        // Instead of throwing an error, return the updated settings
                        if (showIndicator)
                        {
                            Toast.clearSpinner("");
                        }
                        return settings;
                    }

                    // Authentication flow will continue via the URI handler
                    throw new Error(localize("toast.google.auth.wait"));
                }
            }
            else
            {
                // Only check access token for GitHub Gist provider
                // Ask for token when:
                // 1. uploading with an empty token
                // 2. downloading with an empty token and an empty storage ID.
                if ((settings.token == null || isEmptyString(settings.token)) && (forUpload || isEmptyString(settings.id)))
                {
                    settings.token = await Toast.showGitHubTokenInputBox(forUpload);
                }
                if (settings.id == null || isEmptyString(settings.id))
                {
                    settings.id = await this._requestStorageID(settings.token, forUpload);
                }
            }

            await this.saveSettings(settings, true);

            if (showIndicator)
            {
                Toast.clearSpinner("");
            }
            return settings;
        }
        catch (error: any)
        {
            if (showIndicator)
            {
                Toast.clearSpinner("");

                // Only show error as uploading/downloading canceled if it's not an authentication message
                if (error.message !== localize("toast.google.auth.wait"))
                {
                    Toast.statusError(
                        forUpload
                            ? localize("toast.settings.uploading.canceled", error.message)
                            : localize("toast.settings.downloading.canceled", error.message)
                    );
                }
            }
            throw error;
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

        // Non salvare mai client ID e secret nel file syncing.json
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
     * Ask user for storage ID.
     *
     * @param token GitHub Personal Access Token.
     * @param forUpload Whether to show messages for upload. Defaults to `true`.
     */
    private async _requestStorageID(token: string, forUpload: boolean = true): Promise<string>
    {
        if (token != null && !isEmptyString(token))
        {
            const api: Gist = Gist.create(token, this.proxy);
            const id = await Toast.showRemoteStorageListBox(api, forUpload);
            if (isEmptyString(id))
            {
                // Show storage input box when id is still not supplied.
                return Toast.showStorageInputBox(forUpload);
            }
            return id;
        }
        return Toast.showStorageInputBox(forUpload);
    }
}
