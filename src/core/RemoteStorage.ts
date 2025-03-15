import { Octokit } from "@octokit/rest";
import { HttpsProxyAgent } from "https-proxy-agent";
import pick = require("lodash.pick");

import { clearSpinner, showConfirmBox, showSpinner, statusError } from "./Toast";
import { CONFIGURATION_KEY, CONFIGURATION_POKA_YOKE_THRESHOLD } from "../constants";
import { createError } from "../utils/errors";
import { diff } from "../utils/diffPatch";
import { getVSCodeSetting } from "../utils/vscodeAPI";
import { isEmptyString } from "../utils/lang";
import { localize } from "../i18n";
import { parse } from "../utils/jsonc";
import { SettingType } from "../types";
import type {
    StorageCreateParam,
    StorageUpdateParam,
    IRemoteStorage,
    IRemoteFile,
    IRemoteFiles,
    IStorageUser,
    ISetting
} from "../types";

/**
 * Remote Storage utils.
 */
export class RemoteStorage
{
    private static _instance: RemoteStorage;

    /**
     * The description of Syncing's remote storage.
     */
    private static readonly STORAGE_DESCRIPTION: string = "VSCode's Settings - Syncing";

    private _api: Octokit;
    private _proxy?: string;
    private _token?: string;

    private constructor(token?: string, proxy?: string)
    {
        this._proxy = proxy;

        const options: { auth?: any; request: { agent?: any; timeout?: number } } = { request: { timeout: 8000 } };
        if (proxy != null && !isEmptyString(proxy))
        {
            options.request.agent = new HttpsProxyAgent(proxy);
        }

        this._token = token;
        if (token != null && !isEmptyString(token))
        {
            options.auth = `token ${token}`;
        }

        this._api = new Octokit(options);
    }

    /**
     * Creates an instance of the class `RemoteStorage`, only create a new instance if the params are changed.
     *
     * @param token Access Token.
     * @param proxy Proxy url.
     */
    public static create(token?: string, proxy?: string): RemoteStorage
    {
        if (!RemoteStorage._instance || RemoteStorage._instance.token !== token || RemoteStorage._instance.proxy !== proxy)
        {
            RemoteStorage._instance = new RemoteStorage(token, proxy);
        }
        return RemoteStorage._instance;
    }

    /**
     * Gets the Access Token.
     */
    public get token()
    {
        return this._token;
    }

    /**
     * Gets the proxy url.
     */
    public get proxy()
    {
        return this._proxy;
    }

    /**
     * Gets the currently authenticated user.
     *
     * @throws {IEnhancedError}
     */
    public async user(): Promise<IStorageUser>
    {
        try
        {
            return (await this._api.users.getAuthenticated()).data;
        }
        catch (err: any)
        {
            throw this._createError(err);
        }
    }

    /**
     * Gets the remote storage of the currently authenticated user.
     *
     * @param id Remote storage id.
     * @param showIndicator Defaults to `false`, don't show progress indicator.
     *
     * @throws {IEnhancedError}
     */
    public async get(id: string, showIndicator: boolean = false): Promise<IRemoteStorage>
    {
        if (showIndicator)
        {
            showSpinner(localize("toast.settings.checking.remote"));
        }

        try
        {
            const result = (await this._api.gists.get({ gist_id: id })).data as IRemoteStorage;
            if (showIndicator)
            {
                clearSpinner("");
            }
            return result;
        }
        catch (err: any)
        {
            const error = this._createError(err);
            if (showIndicator)
            {
                statusError(localize("toast.settings.downloading.failed", error.message));
            }
            throw error;
        }
    }

    /**
     * Gets all the remote storage items of the currently authenticated user.
     *
     * @throws {IEnhancedError}
     */
    public async getAll(): Promise<IRemoteStorage[]>
    {
        try
        {
            // Find and sort VSCode settings by time in ascending order.
            const items = (await this._api.gists.list()).data as unknown as IRemoteStorage[];
            const extensionsRemoteFilename = `${SettingType.Extensions}.json`;
            return items
                .filter(item => (item.description === RemoteStorage.STORAGE_DESCRIPTION || item.files[extensionsRemoteFilename]))
                .sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime());
        }
        catch (err: any)
        {
            throw this._createError(err);
        }
    }

    /**
     * Delete remote storage.
     *
     * @param id Storage id.
     *
     * @throws {IEnhancedError}
     */
    public async delete(id: string): Promise<void>
    {
        try
        {
            await this._api.gists.delete({ gist_id: id });
        }
        catch (err: any)
        {
            throw this._createError(err);
        }
    }

    /**
     * Update remote storage.
     *
     * @param {StorageUpdateParam} content Remote storage content.
     *
     * @throws {IEnhancedError}
     */
    public async update(content: StorageUpdateParam): Promise<IRemoteStorage>
    {
        try
        {
            // Map storage_id to gist_id for backward compatibility
            const gistContent = {
                gist_id: content.storage_id,
                files: content.files,
                description: content.description
            };

            return (await this._api.gists.update(gistContent as any)).data as IRemoteStorage;
        }
        catch (err: any)
        {
            throw this._createError(err);
        }
    }

    /**
     * Determines whether the specified remote storage exists.
     *
     * @param id Storage id.
     */
    public async exists(id: string): Promise<IRemoteStorage | false>
    {
        if (id != null && !isEmptyString(id))
        {
            try
            {
                const storage = await this.get(id);
                if (this.token != null)
                {
                    const user = await this.user();
                    // Determines whether the owner of the storage is the currently authenticated user.
                    if (user.id !== storage.owner.id)
                    {
                        return false;
                    }
                }
                return storage;
            }
            catch
            {
                // Ignore error.
            }
        }
        return false;
    }

    /**
     * Creates a new remote storage.
     *
     * @param {StorageCreateParam} content Remote storage content.
     *
     * @throws {IEnhancedError}
     */
    public async create(content: StorageCreateParam): Promise<IRemoteStorage>
    {
        try
        {
            return (await this._api.gists.create(content as any)).data as IRemoteStorage;
        }
        catch (err: any)
        {
            throw this._createError(err);
        }
    }

    /**
     * Creates remote storage for VSCode settings.
     *
     * @param files Settings files.
     * @param isPublic Is public gist.
     */
    public createSettings(files = {}, isPublic = false): Promise<IRemoteStorage>
    {
        return this.create({
            description: RemoteStorage.STORAGE_DESCRIPTION,
            files,
            public: isPublic
        });
    }

    /**
     * Find and update (or create) a remote storage, will re-throw error.
     *
     * @param id Storage id.
     * @param uploads Setting files to be uploaded.
     * @param upsert Defaults to `true`. Create a new storage if not exists.
     * @param showIndicator Defaults to `false`, don't show progress indicator.
     */
    public async findAndUpdate(
        id: string,
        uploads: ISetting[],
        upsert = true,
        showIndicator = false
    ): Promise<IRemoteStorage>
    {
        if (showIndicator)
        {
            showSpinner(localize("toast.settings.checking.remote"));
        }

        try
        {
            const exists = await this.exists(id);
            if (showIndicator)
            {
                clearSpinner("");
            }

            let result: IRemoteStorage;
            if (exists)
            {
                if (showIndicator)
                {
                    showSpinner(localize("toast.settings.uploading"));
                }

                // Find modified files.
                const localStorage: IRemoteFiles = {};
                for (const item of uploads)
                {
                    if (item.content != null)
                    {
                        localStorage[item.remoteFilename] = {
                            filename: item.remoteFilename,
                            content: item.content
                        };
                    }
                }

                // Update modified files.
                const localStorageGist = {
                    storage_id: id,
                    files: this.getModifiedFiles(localStorage, exists.files)
                };

                if (localStorageGist.files)
                {
                    // Only upload the modified files.
                    // poka-yoke - Determines whether there're too much changes since the last uploading.
                    const threshold = getVSCodeSetting<number>(CONFIGURATION_KEY, CONFIGURATION_POKA_YOKE_THRESHOLD);
                    const changes = this._diffSettings(exists.files, localStorage);
                    if (threshold > 0 && changes >= threshold)
                    {
                        const okButton = localize("pokaYoke.continue.upload");
                        const selection = await showConfirmBox(
                            localize("pokaYoke.continue.upload.message"),
                            okButton,
                            localize("pokaYoke.cancel")
                        );
                        if (selection !== okButton)
                        {
                            throw createError(localize("error.abort.synchronization"));
                        }
                    }
                    result = await this.update(localStorageGist);
                }
                else
                {
                    // Nothing changed.
                    result = exists;
                }
            }
            else
            {
                if (upsert)
                {
                    // TODO: Pass public option.
                    if (showIndicator)
                    {
                        showSpinner(localize("toast.settings.uploading"));
                    }

                    const files: IRemoteFiles = {};
                    for (const item of uploads)
                    {
                        if (item.content != null)
                        {
                            files[item.remoteFilename] = {
                                filename: item.remoteFilename,
                                content: item.content
                            };
                        }
                    }
                    result = await this.createSettings(files);
                }
                else
                {
                    if (showIndicator)
                    {
                        statusError(localize("toast.settings.uploading.failed", localize("error.storage.notfound", id)));
                    }
                    throw createError(localize("error.storage.notfound", id));
                }
            }

            if (showIndicator)
            {
                clearSpinner("");
            }
            return result;
        }
        catch (err: any)
        {
            const error = this._createError(err);
            if (showIndicator)
            {
                statusError(localize("toast.settings.uploading.failed", error.message));
            }
            throw error;
        }
    }

    /**
     * Gets the modified files.
     *
     * @param {IRemoteFiles} localFiles Local files.
     * @param {IRemoteFiles} [remoteFiles] Remote files.
     */
    public getModifiedFiles(
        localFiles: IRemoteFiles,
        remoteFiles?: IRemoteFiles
    ): IRemoteFiles | undefined
    {
        if (remoteFiles)
        {
            const result = {} as IRemoteFiles;
            let localFile: IRemoteFile;
            let remoteFile: IRemoteFile;
            let isModified = false;

            // Update existing files and `delete` missing.
            const reservedFilenames: string[] = [];
            for (const filename of Object.keys(remoteFiles))
            {
                remoteFile = remoteFiles[filename];
                localFile = localFiles[filename];
                if (localFile && localFile.content)
                {
                    if (localFile.content !== remoteFile.content)
                    {
                        // Update file.
                        isModified = true;
                        result[filename] = {
                            ...pick(remoteFile, ["content", "filename"]),
                            ...pick(localFile, ["content", "filename"])
                        };
                    }
                    reservedFilenames.push(filename);
                }
                else
                {
                    // Delete file, using `null` as tricky.
                    isModified = true;
                    result[filename] = null as any;
                }
            }

            // Add new files.
            for (const filename of Object.keys(localFiles))
            {
                if (!reservedFilenames.includes(filename))
                {
                    isModified = true;
                    localFile = localFiles[filename];
                    result[filename] = {
                        ...pick(localFile, ["content", "filename"])
                    };
                }
            }

            return isModified ? result : undefined;
        }

        // If remoteFiles is not exist, returns all localFiles directly.
        return localFiles;
    }


    /**
     * Gets settings from a remote storage.
     *
     * @param id Storage ID.
     * @param checkOwnerShip Whether to check ownership. Defaults to `true`.
     * @param showIndicator Whether to show progress indicator. Defaults to `false`.
     *
     * @throws {IEnhancedError}
     */
    public async getSettings(id: string, checkOwnerShip: boolean = true, showIndicator: boolean = false): Promise<Record<string, any>>
    {
        let remoteStorage: IRemoteStorage | false;
        if (showIndicator)
        {
            showSpinner(localize("toast.settings.downloading"));
        }

        try
        {
            // 1. Find the remote storage.
            remoteStorage = await this.get(id, showIndicator);
            if (remoteStorage)
            {
                if (checkOwnerShip && this.token != null)
                {
                    // 2. Check ownership.
                    const user = await this.user();
                    if (user.id !== remoteStorage.owner.id)
                    {
                        // Ownership checked failed.
                        throw new Error(localize("error.ownership.check.failed", id));
                    }
                }

                // 3. Merge all storage content.
                const setting = await this.mergeSettings(remoteStorage);
                if (showIndicator)
                {
                    clearSpinner("");
                }
                return setting;
            }
            else
            {
                throw new Error(localize("error.storage.notfound", id));
            }
        }
        catch (err: any)
        {
            const error = this._createError(err);
            if (showIndicator)
            {
                statusError(error.message);
            }
            throw error;
        }
    }

    /**
     * Creates the error from an error object.
     */
    private _createError(error: Error & { status: number })
    {
        if (error.status === 401)
        {
            return createError(localize("error.check.storage.token"), error.status);
        }
        else if (error.status === 404)
        {
            return createError(localize("error.storage.notfound", error.message), error.status);
        }
        return createError(error.message, error.status);
    }

    /**
     * Calculates the number of differences between the local and remote files.
     */
    private _diffSettings(localFiles: IRemoteFiles, remoteFiles: IRemoteFiles): number
    {
        const left = this._parseToJSON(localFiles);
        const right = this._parseToJSON(remoteFiles);
        return diff(left, right);
    }

    /**
     * Converts the `content` of `IRemoteFiles` into a `JSON object`.
     */
    private _parseToJSON(files: IRemoteFiles): Record<string, any>
    {
        let file: IRemoteFile;
        let parsed: any;
        const result: Record<string, any> = {};
        for (const filename of Object.keys(files))
        {
            if (filename === `${SettingType.Extensions}.json`)
            {
                file = files[filename];
                parsed = parse(file.content);
                if (Array.isArray(parsed))
                {
                    result[filename] = JSON.stringify(
                        parsed.map(ext =>
                        {
                            if (ext["id"] != null)
                            {
                                ext["id"] = ext["id"].toLocaleLowerCase();
                            }
                            return ext;
                        })
                    );
                }
                else
                {
                    result[filename] = file.content;
                }
            }
            else
            {
                file = files[filename];
                result[filename] = file.content;
            }
        }
        return result;
    }


    /**
     * Merges remote storage content into one setting object.
     *
     * @param storage Remote storage.
     *
     * @throws {IEnhancedError}
     */
    private mergeSettings(storage: IRemoteStorage): Promise<Record<string, any>>
    {
        return new Promise<Record<string, any>>((resolve, reject) =>
        {
            try
            {
                const settings: Record<string, any> = {};
                const files = storage.files;
                if (!files)
                {
                    reject(new Error(localize("error.storage.files.notfound")));
                }
                else
                {
                    for (const filename of Object.keys(files))
                    {
                        const file = files[filename];
                        if (file.content && file.content.startsWith("{") && file.content.endsWith("}"))
                        {
                            const json = parse(file.content);
                            if (json.extensions)
                            {
                                settings.extensions = { added: [], updated: [], removed: [] };
                                settings.extensions.added = json.extensions.added;
                                settings.extensions.updated = json.extensions.updated;
                                settings.extensions.removed = json.extensions.removed;
                            }
                            else if (json.locale)
                            {
                                settings.locale = json.locale;
                            }
                            else if (json.snippets)
                            {
                                if (!settings.snippets)
                                {
                                    settings.snippets = {};
                                }
                                const key = filename.replace(/\.json$/i, "").replace("Snippets__", "");
                                settings.snippets[key] = json.snippets;
                            }
                            else
                            {
                                const key = filename.replace(/\.json$/i, "");
                                const type = key.toLowerCase() as SettingType;
                                settings[type] = json;
                            }
                        }
                    }
                    resolve(settings);
                }
            }
            catch (err: any)
            {
                reject(this._createError(err));
            }
        });
    }
}
