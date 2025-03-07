/**
 * Represents the `Syncing Settings`.
 */
export interface ISyncingSettings
{
    /**
     * Store the GitHub Gist ID.
     */
    id: string;

    /**
     * Store the GitHub Personal Access Token.
     */
    token: string;

    /**
     * Store the http proxy setting.
     */
    http_proxy: string | undefined;

    /**
     * Store the auto-sync setting.
     */
    auto_sync: boolean;
}

/**
 * Represents various kinds of `VSCode Settings`, such as `Extensions`, `Keybindings`...
 */
export enum SettingType
{
    Extensions = "extensions",
    Keybindings = "keybindings",
    Locale = "locale",
    Settings = "settings",
    Snippets = "snippets",
    StateDB = "state"
}

/**
 * Represents a `VSCode Setting`.
 */
export interface ISetting
{
    /**
     * The corresponding local file path.
     */
    localFilePath: string;

    /**
     * The corresponding remote filename.
     */
    remoteFilename: string;

    type: SettingType;

    /**
     * The content of the setting.
     */
    content?: string;

    /**
     * The last modified time (in milliseconds) of the setting.
     */
    lastModified?: number;
}

/**
 * Represents a VSCode extension.
 */
export interface IExtension
{
    /**
     * The extension's identifier is in the form of: `publisher.name`.
     */
    id: string;

    /**
     * The extension's name.
     */
    name: string;

    /**
     * The extension's publisher.
     */
    publisher: string;

    /**
     * The extension's version.
     */
    version: string;

    /**
     * The downloaded extension's vsix file path.
     */
    vsixFilepath?: string;

    /**
     * The extension's download url in marketplace.
     */
    downloadURL?: string;

    isActive: boolean;
}

/**
 * Represents the currently synced item.
 */
export interface ISyncedItem
{
    /**
     * Extensions that have been added, updated or removed.
     */
    extension?: {
        added: IExtension[];
        addedErrors: IExtension[];
        updated: IExtension[];
        updatedErrors: IExtension[];
        removed: IExtension[];
        removedErrors: IExtension[];
    };

    /**
     * `VSCode Setting` that have been added, updated or removed.
     */
    setting?: ISetting;
}
