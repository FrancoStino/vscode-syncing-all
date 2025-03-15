import { SettingType, StorageProvider, VSCodeEdition } from "../types";

/**
 * Note that this is an ordered list, to ensure that the smaller files
 * (such as `settings.json`, `keybindings.json`) are synced first.
 * Thus, the `extensions` will be the last one to sync.
 */
export const VSCODE_SETTINGS_LIST = [
    SettingType.Settings,
    SettingType.Keybindings,
    SettingType.Snippets,
    SettingType.StateDB,
    SettingType.Extensions
];

/**
 * Dot-separated identifiers, same as the sections of VSCode, see `vscode.workspace.getConfiguration`.
 */
export const CONFIGURATION_KEY = "syncing";
export const CONFIGURATION_EXCLUDED_EXTENSIONS = "excludedExtensions";
export const CONFIGURATION_EXCLUDED_SETTINGS = "excludedSettings";
export const CONFIGURATION_EXTENSIONS_AUTOUPDATE = "extensions.autoUpdate";
export const CONFIGURATION_POKA_YOKE_THRESHOLD = "pokaYokeThreshold";
export const CONFIGURATION_SEPARATE_KEYBINDINGS = "separateKeybindings";
export const CONFIGURATION_DEFAULT_STORAGE_PROVIDER = "defaultStorageProvider";

/**
 * Default storage provider
 */
export const DEFAULT_STORAGE_PROVIDER: StorageProvider = StorageProvider.GitHubGist;

/**
 * Default Google Drive client ID
 */
export const DEFAULT_GOOGLE_CLIENT_ID = "370061283817-e27q5tnlomtvvtmmdf784o0q1ocs91ef.apps.googleusercontent.com";

/**
 * Default Google Drive client secret
 */
export const DEFAULT_GOOGLE_CLIENT_SECRET = "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";

/**
 * Default port for OAuth callback server
 * Change this value if port 3000 is already in use on your system
 */
export const OAUTH_SERVER_PORT = 8888;

/**
 * Dot-separated identifiers, used to access the properties of Syncing's VSCode settings.
 */
export const SETTING_EXCLUDED_EXTENSIONS = `${CONFIGURATION_KEY}.${CONFIGURATION_EXCLUDED_EXTENSIONS}`;
export const SETTING_EXCLUDED_SETTINGS = `${CONFIGURATION_KEY}.${CONFIGURATION_EXCLUDED_SETTINGS}`;

/**
 * The builtin-environments of different VSCode editions.
 */
export const VSCODE_BUILTIN_ENVIRONMENTS: Record<VSCodeEdition, {
    dataDirectoryName: string;
    extensionsDirectoryName: string;
}> = {
    [VSCodeEdition.STANDARD]: {
        dataDirectoryName: "Code",
        extensionsDirectoryName: ".vscode"
    },
    [VSCodeEdition.INSIDERS]: {
        dataDirectoryName: "Code - Insiders",
        extensionsDirectoryName: ".vscode-insiders"
    },
    [VSCodeEdition.EXPLORATION]: {
        dataDirectoryName: "Code - Exploration",
        extensionsDirectoryName: ".vscode-exploration"
    },
    [VSCodeEdition.VSCODIUM]: {
        dataDirectoryName: "VSCodium",
        extensionsDirectoryName: ".vscode-oss"
    },
    [VSCodeEdition.VSCODIUM_INSIDERS]: {
        dataDirectoryName: "VSCodium - Insiders",
        extensionsDirectoryName: ".vscodium-insiders"
    },
    [VSCodeEdition.OSS]: {
        dataDirectoryName: "Code - OSS",
        extensionsDirectoryName: ".vscode-oss"
    },
    [VSCodeEdition.CODER]: {
        dataDirectoryName: "Code",
        extensionsDirectoryName: "vscode"
    },
    [VSCodeEdition.CODESERVER]: {
        dataDirectoryName: "../.local/share/code-server",
        extensionsDirectoryName: ".local/share/code-server"
    },
    [VSCodeEdition.CURSOR]: {
        dataDirectoryName: "Cursor",
        extensionsDirectoryName: ".cursor"
    }
};
