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

// Type aliases for backward compatibility with existing code
// Now they refer to Google Drive storage
export type IGoogleDrive = IRemoteStorage;
export type IGoogleDriveFiles = IRemoteFiles;
export type IGoogleDriveFile = IRemoteFile;
export type IGoogleDriveUser = IStorageUser;
export type IGoogleDriveHistory = IStorageHistory;
export type GoogleDriveCreateParam = StorageCreateParam;
export type GoogleDriveUpdateParam = StorageUpdateParam;
