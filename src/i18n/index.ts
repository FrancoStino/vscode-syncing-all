import { readJsonSync } from "fs-extra";
import * as path from "path";

import { format } from "../utils/template";
import { getNormalizedVSCodeLocale } from "../utils/vscodeAPI";
import type { NormalizedLocale } from "../types";

let instance: I18n;

class I18n
{
    private static _instance: I18n;
    private static _DEFAULT_LOCALE_FILENAME: string = "package.nls.json";

    private _bundle: Record<string, string>;
    private _extensionPath: string;
    private _locale: NormalizedLocale;

    private constructor(extensionPath: string)
    {
        this._extensionPath = extensionPath;
        this._locale = getNormalizedVSCodeLocale();
        this._prepare();
    }

    /**
     * Creates an instance of the singleton class `I18n`.
     */
    public static create(extensionPath: string): I18n
    {
        if (!I18n._instance || I18n._instance._extensionPath !== extensionPath)
        {
            I18n._instance = new I18n(extensionPath);
        }
        return I18n._instance;
    }

    /**
     * Gets the VSCode locale.
     */
    public get locale(): NormalizedLocale
    {
        return this._locale;
    }

    /**
     * Gets the localized string corresponding to the provided key.
     *
     * @param {string} key The template string key.
     * @param {...any[]} templateValues If the message is a template string,
     * these args will be used to replace the templates.
     */
    public localize(key: string, ...templateValues: any[]): string
    {
        // `key` value shouldn't have leading dot.
        let normalizedKey = key;
        if (normalizedKey.startsWith("."))
        {
            normalizedKey = normalizedKey.substr(1);
        }

        const value = normalizedKey in this._bundle
            ? this._bundle[normalizedKey]
            : normalizedKey;

        if (templateValues && templateValues.length > 0)
        {
            return format(value, templateValues);
        }
        return value;
    }

    /**
     * Prepare the message bundle.
     */
    private _prepare()
    {
        this._bundle = {
            "error.initialization": "Failed to initialize Syncing: {0}",
            "error.check.internet": "Please check your Internet connection.",
            "error.check.token": "Invalid Access Token. Please generate a new token.",
            "error.check.storage.id": "Invalid Storage ID. Please retry with another one.",
            "error.check.folder.id": "Invalid Google Drive folder ID. Please ensure it's correct.",
            "error.check.google.credentials": "Invalid Google Drive credentials. Please check your Client ID and Client Secret.",
            "error.no.refresh.token": "No refresh token received from Google. Please ensure you've granted the necessary permissions.",
            "error.missing.google.credentials": "Missing Google Drive credentials. Please configure Client ID, Client Secret, and Refresh Token.",
            "error.creating.folder": "Error creating folder in Google Drive.",
            "error.abort.synchronization": "User aborted synchronization.",
            "error.storage.files.notfound": "No files found in the remote storage.",
            "error.empty.token.or.id": "Access token or Storage ID is empty.",
            "error.invalid.settings": "Invalid settings file(s): \r\n{0}\r\nThese files will be skipped.",
            "error.loading.settings": "Failed to load {0}: {1}.",
            "error.loading.snippets": "Failed to load code snippets.",
            "error.remove.file": "Failed to remove {0}: {1}",
            "error.save.file": "Failed to save {0}: {1}",
            "error.no.storage.id": "No Storage ID provided. Please configure your Storage ID.",
            "error.ownership.check.failed": "You are not the owner of this Storage ID: {0}",
            "pokaYoke.cancel": "Cancel",
            "pokaYoke.continue.download": "Continue",
            "pokaYoke.continue.download.message": "There're too many changes in the downloaded settings. Are you sure to continue?",
            "toast.settings.checking.remote": "Checking remote settings...",
            "toast.settings.checking.remote.storage": "Checking remote storage...",
            "toast.settings.downloading": "Downloading settings...",
            "toast.settings.downloading.failed": "Failed to download settings: {0}",
            "toast.settings.gathering.local": "Gathering local settings...",
            "toast.settings.uploading": "Uploading settings...",
            "toast.settings.uploaded": "Settings uploaded.",
            "toast.settings.uploading.canceled": "Settings uploading canceled: {0}",
            "toast.settings.uploading.failed": "Uploading failed: {0}",
            "toast.settings.downloading.canceled": "Settings downloading canceled: {0}",
            "toast.syncing.checking.settings": "Checking Syncing's settings...",
            "toast.vscode.restart": "Please restart VSCode to apply the settings.",
            "toast.settings.initialized": "Syncing initialized successfully.",
            "toast.init.failed": "Failed to initialize Syncing.",
            "toast.settings.synced": "Settings synchronized successfully.",
            "toast.settings.synced.with.errors.single": "Settings synchronized with errors in: {0}",
            "toast.settings.synced.with.errors.double": "Settings synchronized with errors in: {0} and {1}",
            "toast.settings.synced.with.errors.multiple": "Settings synchronized with errors in {0} items",
            "toast.settings.show.reload.message": "Settings have been synchronized. Would you like to reload the window to apply changes?",
            "toast.settings.show.reload.button.text": "Reload",
            "toast.settings.show.reload.later.button.text": "Later",
            "toast.initializing": "Initializing Syncing..."
        };

        try
        {
            // nls.<locale>.json
            // Use either an existing bundle or the default bundle.
            const defaultBundlePath = path.join(this._extensionPath, I18n._DEFAULT_LOCALE_FILENAME);
            this._bundle = readJsonSync(defaultBundlePath);

            // Try to load localized strings if available
            try
            {
                const localeFilename = path.join(this._extensionPath, `package.nls.${this._locale}.json`);
                const localizedBundle = readJsonSync(localeFilename);
                this._bundle = Object.assign(this._bundle, localizedBundle);
            }
            catch { /* Ignore localization load errors */ }
        }
        catch (err: any)
        {
            console.error("Failed to parse the i18n bundle:", err);
        }
    }
}

/**
 * Setup the i18n module.
 */
export function setup(extensionPath: string): void
{
    instance = I18n.create(extensionPath);
}

/**
 * Gets the VSCode locale.
 */
export function locale(): NormalizedLocale
{
    return instance.locale;
}

/**
 * Gets the localized message.
 *
 * @param {string} key The key of the message.
 * @param {...any[]} templateValues If the message is a template string,
 * these args will be used to replace the templates.
 */
export function localize(key: string, ...templateValues: any[]): string
{
    return instance.localize(key, ...templateValues);
}
