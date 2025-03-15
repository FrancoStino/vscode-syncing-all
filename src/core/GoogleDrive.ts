import { google } from "googleapis";

import { clearSpinner, showSpinner, statusError } from "./Toast";
import { localize } from "../i18n";
import { SettingType } from "../types";
import { createError } from "../utils/errors";
import type { IGist as IRemoteStorage, IGistFiles as IRemoteFiles, ISetting } from "../types";

/**
 * Google Drive utils.
 */
export class GoogleDrive
{
    private static _instance: GoogleDrive;

    /**
     * The folder name for Syncing's files in Google Drive.
     */
    private static readonly FOLDER_NAME: string = "VSCode's Settings - Syncing";

    private _auth: any;
    private _folderId: string | undefined;
    private _clientId?: string;
    private _clientSecret?: string;
    private _refreshToken?: string;

    private constructor(clientId?: string, clientSecret?: string, refreshToken?: string, folderId?: string)
    {
        this._clientId = clientId;
        this._clientSecret = clientSecret;
        this._refreshToken = refreshToken;
        this._folderId = folderId;

        if (clientId && clientSecret)
        {
            this._auth = new google.auth.OAuth2({
                clientId,
                clientSecret,
                redirectUri: "http://localhost:3000" // Redirect URI for desktop apps
            });

            if (refreshToken)
            {
                this._auth.setCredentials({
                    refresh_token: refreshToken
                });
            }
        }
    }

    /**
     * Creates an instance of the class `GoogleDrive`, only create a new instance if the params are changed.
     *
     * @param clientId Google Drive API Client ID.
     * @param clientSecret Google Drive API Client Secret.
     * @param refreshToken Google Drive API Refresh Token.
     * @param folderId Optional folder ID to use directly.
     */
    public static create(clientId?: string, clientSecret?: string, refreshToken?: string, folderId?: string): GoogleDrive
    {
        if (!GoogleDrive._instance ||
            GoogleDrive._instance.clientId !== clientId ||
            GoogleDrive._instance.clientSecret !== clientSecret ||
            GoogleDrive._instance.refreshToken !== refreshToken)
        {
            GoogleDrive._instance = new GoogleDrive(clientId, clientSecret, refreshToken, folderId);
        }
        else if (folderId && GoogleDrive._instance._folderId !== folderId)
        {
            // Update folder ID if it's changed
            GoogleDrive._instance._folderId = folderId;
        }
        return GoogleDrive._instance;
    }

    /**
     * Gets the Google Drive API Client ID.
     */
    public get clientId(): string | undefined
    {
        return this._clientId;
    }

    /**
     * Gets the Google Drive API Client Secret.
     */
    public get clientSecret(): string | undefined
    {
        return this._clientSecret;
    }

    /**
     * Gets the Google Drive API Refresh Token.
     */
    public get refreshToken(): string | undefined
    {
        return this._refreshToken;
    }

    /**
     * Get the URL for user authorization
     */
    public getAuthUrl(): string
    {
        if (!this._auth)
        {
            throw createError(localize("error.check.google.credentials"), 401);
        }

        return this._auth.generateAuthUrl({
            access_type: "offline",
            scope: ["https://www.googleapis.com/auth/drive.file"],
            prompt: "consent"
        });
    }

    /**
     * Exchange authorization code for refresh token
     * @param authCode The authorization code from Google
     */
    public async getRefreshToken(authCode: string): Promise<string>
    {
        if (!this._auth)
        {
            throw createError(localize("error.check.google.credentials"), 401);
        }

        try
        {
            const { tokens } = await this._auth.getToken(authCode);
            this._auth.setCredentials(tokens);
            this._refreshToken = tokens.refresh_token;

            if (!tokens.refresh_token)
            {
                throw createError(localize("error.no.refresh.token"), 401);
            }

            return tokens.refresh_token;
        }
        catch (err: any)
        {
            throw this._createError(err);
        }
    }

    /**
     * Gets files from Google Drive.
     *
     * @param showIndicator Defaults to `false`, don't show progress indicator.
     */
    public async getFiles(showIndicator: boolean = false): Promise<IRemoteStorage>
    {
        if (showIndicator)
        {
            showSpinner(localize("toast.settings.checking.remote"));
        }

        if (!this._auth)
        {
            throw createError(localize("error.check.google.credentials"), 401);
        }

        try
        {
            const folderId = await this._getOrCreateFolder();
            const drive = google.drive({ version: "v3", auth: this._auth });

            // Use a simpler query format to avoid potential issues
            console.log("Using folder ID:", folderId);
            const response = await drive.files.list({
                q: `'${folderId}' in parents and trashed=false`,
                spaces: "drive",
                fields: "files(id, name, modifiedTime, mimeType)"
            });

            const files = response.data?.files ?? [];
            console.log(`Found ${files.length} files in Google Drive folder`);

            // Get content for each file
            const driveFiles: IRemoteFiles = {};
            for (const file of files)
            {
                if (file.id && file.name)
                {
                    console.log(`Processing file: ${file.name}, ID: ${file.id}, MIME type: ${file.mimeType ?? "unknown"}`);
                    try
                    {
                        const content = await this._downloadFile(file.id);
                        driveFiles[file.name] = {
                            filename: file.name,
                            content
                        };
                    }
                    catch (fileError)
                    {
                        console.error(`Error downloading ${file.name}:`, fileError);
                        // Continue with other files instead of failing completely
                        // For critical files, we might want to rethrow
                        if (file.name === "state.vscdb")
                        {
                            console.warn("Error downloading state.vscdb file - this may cause issues");
                        }
                    }
                }
            }

            if (Object.keys(driveFiles).length === 0)
            {
                console.log("No files were successfully downloaded from Google Drive");
            }

            // Format as a remote storage object
            const result: IRemoteStorage = {
                id: folderId,
                description: GoogleDrive.FOLDER_NAME,
                files: driveFiles,
                updated_at: new Date().toISOString(),
                // Default owner information
                owner: { id: 1, login: "google-drive" },
                public: false,
                history: []
            };

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
     * Checks if settings exist in Google Drive.
     */
    public async exists(_id?: string): Promise<IRemoteStorage | false>
    {
        if (!this._auth)
        {
            return false;
        }

        try
        {
            // Instead of using id, we'll check if the folder exists
            const folderId = await this._getOrCreateFolder();
            if (folderId)
            {
                return await this.getFiles();
            }
        }
        catch
        {
            // Ignore error
        }

        return false;
    }

    /**
     * Upload settings to Google Drive
     *
     * @param settings Settings that will be uploaded (can be a single setting or an array)
     * @param showIndicator Whether to show indicator during upload
     */
    public async uploadSettings(settings: ISetting | ISetting[], showIndicator: boolean = false): Promise<IRemoteStorage>
    {
        if (showIndicator)
        {
            showSpinner(localize("toast.settings.uploading"));
        }

        if (!this._auth)
        {
            throw createError(localize("error.check.google.credentials"), 401);
        }

        try
        {
            const folderId = await this._getOrCreateFolder();

            // Handle single setting object by wrapping it in an array
            const uploads = Array.isArray(settings) ? settings : [settings];

            // Upload each file
            for (const item of uploads)
            {
                // Filter out `null` content.
                if (item.content != null)
                {
                    await this._uploadFile(folderId, item);
                }
            }

            // Invece di chiamare getFiles, restituiamo un oggetto semplificato
            const result: IRemoteStorage = {
                id: folderId,
                description: GoogleDrive.FOLDER_NAME,
                files: {}, // Non servono dettagli sui file
                updated_at: new Date().toISOString(),
                owner: { id: 1, login: "google-drive" },
                public: false,
                history: []
            };

            if (showIndicator)
            {
                clearSpinner("");
            }

            return result;
        }
        catch (error: any)
        {
            if (showIndicator)
            {
                statusError(localize("toast.settings.uploading.failed", error.message));
            }
            throw error;
        }
    }

    /**
     * Download settings from Google Drive
     *
     * @param showIndicator Whether to show indicator during download
     */
    public async downloadSettings(showIndicator: boolean = false): Promise<IRemoteStorage>
    {
        if (showIndicator)
        {
            showSpinner(localize("toast.settings.downloading"));
        }

        try
        {
            // Find the settings file in the Syncing folder
            const files = await this.getFiles(showIndicator);

            if (showIndicator)
            {
                clearSpinner("");
            }

            return files;
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
     * Escape special characters in a string for use in a Google Drive query
     */
    private static _escapeQueryString(str: string): string
    {
        // Escape single quotes with backslash
        return str.replace(/'/g, "\\'");
    }

    /**
     * Gets the settings folder from Google Drive.
     * Creates it if it doesn't exist.
     */
    private async _getOrCreateFolder(): Promise<string>
    {
        // If we already have a folder ID from a previous call, use it
        if (this._folderId)
        {
            console.log("Using cached folder ID:", this._folderId);
            return this._folderId;
        }

        if (!this._auth)
        {
            throw createError(localize("error.check.google.credentials"), 401);
        }

        const drive = google.drive({ version: "v3", auth: this._auth });

        // Prioritize the saved ID in syncing.json if it exists
        // We can assume that if this class is being used, the ID was provided in the constructor
        // and saved in the instance which would be available through the Syncing class
        if (this._folderId)
        {
            console.log("Using configured folder ID:", this._folderId);

            // Verify that the folder exists
            try
            {
                const response = await drive.files.get({
                    fileId: this._folderId,
                    fields: "id, name"
                });

                if (response.data && response.data.id)
                {
                    return this._folderId;
                }
            }
            catch (err)
            {
                console.warn("Configured folder ID not found, will create a new one:", err);
                // If the folder doesn't exist, we'll fall through to create a new one
            }
        }

        try
        {
            // First check if folder already exists
            const escapedFolderName = GoogleDrive._escapeQueryString(GoogleDrive.FOLDER_NAME);
            const response = await drive.files.list({
                q: `name='${escapedFolderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                spaces: "drive",
                fields: "files(id, name)"
            });

            const files = response.data?.files;
            if (files && files.length > 0 && files[0].id)
            {
                this._folderId = files[0].id;
                console.log("Found existing folder:", this._folderId);
                return this._folderId;
            }

            // Create a new folder
            const fileMetadata = {
                name: GoogleDrive.FOLDER_NAME,
                mimeType: "application/vnd.google-apps.folder"
            };

            const file = await drive.files.create({
                requestBody: fileMetadata,
                fields: "id"
            });

            if (file.data.id)
            {
                this._folderId = file.data.id;
                console.log("Created new folder:", this._folderId);
                return this._folderId;
            }
            else
            {
                throw createError(localize("error.creating.folder"), 500);
            }
        }
        catch (err: any)
        {
            throw this._createError(err);
        }
    }

    /**
     * Downloads a file from Google Drive.
     */
    private async _downloadFile(fileId: string): Promise<string>
    {
        if (!this._auth)
        {
            throw createError(localize("error.check.google.credentials"), 401);
        }

        const drive = google.drive({ version: "v3", auth: this._auth });

        try
        {
            // First get file metadata to check the name
            const metadata = await drive.files.get({
                fileId,
                fields: "name, mimeType"
            });

            const fileName = metadata.data.name ?? "";
            const isStateDB = fileName === "state.vscdb";
            const isBinary = isStateDB || (metadata.data.mimeType && metadata.data.mimeType.includes("octet-stream"));

            console.log(`Downloading file: ${fileName}, is state.vscdb: ${isStateDB}, mime type: ${metadata.data.mimeType}`);

            // Now get the file content
            const response = await drive.files.get({
                fileId,
                alt: "media"
            }, {
                responseType: "arraybuffer"
            });

            // Check if it's a state.vscdb file, or if metadata indicates it's binary,
            // or if content-type header indicates it's binary
            const contentType = response.headers && response.headers["content-type"]
                ? String(response.headers["content-type"])
                : "";

            const isContentTypeBinary = contentType && contentType.includes("octet-stream");
            console.log(`Content-Type header: ${contentType}, is binary according to header: ${isContentTypeBinary}`);

            if (isStateDB ?? isBinary ?? isContentTypeBinary)
            {
                // For binary files, return base64 encoded string
                console.log(`Downloaded binary file (${fileName}), encoding as base64`);
                return Buffer.from(response.data as ArrayBuffer).toString("base64");
            }
            else
            {
                // For text files, return UTF-8 encoded string
                console.log(`Downloaded text file (${fileName})`);
                return Buffer.from(response.data as ArrayBuffer).toString("utf8");
            }
        }
        catch (err: any)
        {
            console.error("Error downloading file:", err);
            throw this._createError(err);
        }
    }

    /**
     * Uploads a file to Google Drive.
     */
    private async _uploadFile(folderId: string, setting: ISetting): Promise<void>
    {
        if (!this._auth)
        {
            throw createError(localize("error.check.google.credentials"), 401);
        }

        const drive = google.drive({ version: "v3", auth: this._auth });

        try
        {
            // Escape any special characters in the filename
            const escapedFilename = GoogleDrive._escapeQueryString(setting.remoteFilename);
            console.log(`Uploading file: ${setting.remoteFilename}, type: ${setting.type}`);

            // Check if the file already exists
            const response = await drive.files.list({
                q: `'${folderId}' in parents and name='${escapedFilename}' and trashed=false`,
                spaces: "drive",
                fields: "files(id, name)"
            });

            const files = response.data?.files ?? [];
            const isStateDB = setting.type === SettingType.StateDB;

            let fileContent: string | Buffer = setting.content ?? "";
            let mimeType = "application/json";

            // Convert base64 string back to binary for state.vscdb
            if (isStateDB && typeof fileContent === "string")
            {
                console.log("Converting state.vscdb from base64 to binary buffer");
                fileContent = Buffer.from(fileContent, "base64");
                mimeType = "application/octet-stream";
            }

            // Import the Readable stream from 'stream' module
            const { Readable } = require("stream");

            // Create a readable stream from the content
            let contentStream;
            // Workaround for Node.js 8.0.0 which doesn't support Readable.from
            if (typeof fileContent === "string")
            {
                contentStream = new Readable();
                contentStream._read = () => { }; // No-op implementation required
                contentStream.push(fileContent);
                contentStream.push(null); // End of stream
            }
            else
            {
                contentStream = new Readable();
                contentStream._read = () => { }; // No-op implementation required
                contentStream.push(fileContent);
                contentStream.push(null); // End of stream
            }

            // Create or update file
            if (files.length > 0)
            {
                // Update existing file
                const fileId = files[0].id;
                if (fileId)
                {
                    console.log(`Updating existing file: ${setting.remoteFilename} (ID: ${fileId})`);
                    await drive.files.update({
                        fileId,
                        media: {
                            mimeType,
                            body: contentStream
                        }
                    });
                }
            }
            else
            {
                // Create new file
                console.log(`Creating new file: ${setting.remoteFilename}`);
                await drive.files.create({
                    requestBody: {
                        name: setting.remoteFilename,
                        parents: [folderId]
                    },
                    media: {
                        mimeType,
                        body: contentStream
                    }
                });
            }
        }
        catch (err: any)
        {
            console.error(`Error uploading file ${setting.remoteFilename}:`, err);
            throw this._createError(err);
        }
    }

    /**
     * Creates the error from an error object.
     */
    private _createError(error: any)
    {
        console.error("Syncing Google Drive:", error);

        // Log additional error details if available
        if (error.response)
        {
            console.error("Error response:", JSON.stringify(error.response.data, null, 2));
        }

        if (error.code === 400)
        {
            return createError(`Invalid Value: ${error.message ?? "Unknown error"}`, error.code);
        }

        return createError(error.message ?? localize("error.check.google.credentials"), error.code ?? 500);
    }
}
