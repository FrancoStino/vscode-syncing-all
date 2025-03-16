export * from "./RemoteStorageTypes";
export * from "./NormalizedLocale";
export * from "./Platform";
export * from "./SyncingTypes";
export * from "./VSCodeEdition";
export * from "./VSCodeExtensionGallery";

// Aliases for backward compatibility
import type {
    IRemoteStorage,
    IRemoteFiles,
    IRemoteFile,
    IStorageUser,
    IStorageHistory,
    StorageCreateParam,
    StorageUpdateParam
} from "./RemoteStorageTypes";

// Type aliases for backward compatibility with existing code that referred to Gist
// Now they refer to Google Drive storage
export type IGist = IRemoteStorage;
export type IGistFiles = IRemoteFiles;
export type IGistFile = IRemoteFile;
export type IGistUser = IStorageUser;
export type IGistHistory = IStorageHistory;
export type GistCreateParam = StorageCreateParam;
export type GistUpdateParam = StorageUpdateParam;
