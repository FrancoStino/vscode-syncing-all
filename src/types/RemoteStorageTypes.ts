/**
 * Represents the Remote Storage for settings.
 */
export interface IRemoteStorage
{
    description: string;
    files: IRemoteFiles;
    history: IStorageHistory[];
    id: string;
    owner: IStorageUser;
    public: boolean;

    /**
     * The last update time, such as "2019-04-26T01:43:01Z".
     */
    updated_at: string;
}

/**
 * Represents the `files` of the Remote Storage.
 */
export type IRemoteFiles = Record<string, IRemoteFile>;

/**
 * Represents the `file` of the Remote Storage.
 */
export interface IRemoteFile
{
    content: string;
    filename: string;
}

/**
 * Represents the `user` of the Remote Storage.
 */
export interface IStorageUser
{
    id: number;
    login: string;
}

/**
 * Represents the `history` of the Remote Storage.
 */
export interface IStorageHistory
{
    /**
     * Date string.
     */
    committed_at: string;

    url: string;
    user: IStorageUser;
    version: string;
}

/**
 * Represents the param used to create a new Remote Storage item.
 */
export interface StorageCreateParam
{
    files: IRemoteFiles;

    description?: string;
    public?: boolean;
}

/**
 * Represents the param used to update the Remote Storage.
 */
export interface StorageUpdateParam
{
    storage_id: string;

    /**
     * Set file to `null` to delete the file.
     */
    files?: IRemoteFiles;

    description?: string;
}
