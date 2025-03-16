/* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
import { google } from "googleapis";
import * as vscode from "vscode";
import * as http from "http";
import * as url from "url";

import { clearSpinner, showSpinner, statusError } from "./Toast";
import { localize } from "../i18n";
import { SettingType } from "../types";
import { createError } from "../utils/errors";
import { OAUTH_SERVER_PORT } from "../constants";
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
                // Use configurable port for callback server
                redirectUri: `http://localhost:${OAUTH_SERVER_PORT}/oauth2callback`
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
     * Opens the browser for authentication and returns a refresh token
     */
    public async authenticate(): Promise<void>
    {
        if (!this._auth)
        {
            throw createError(localize("error.check.google.credentials"), 401);
        }

        try
        {
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            const authUrl = this.getAuthUrl();

            // Create a promise that will be resolved when we get the auth code
            const authCodePromise = new Promise<string>((resolve, reject) =>
            {
                // Create a local server to receive the OAuth callback
                const server = http.createServer(async (req, res) =>
                {
                    try
                    {
                        // Log ogni richiesta ricevuta dal server
                        console.log("Received request:", req.method, req.url);

                        // Torno a usare url.parse per compatibilità con Node.js 8.0.0
                        const reqUrl = req.url || "";
                        // eslint-disable-next-line node/no-deprecated-api
                        const parsedUrl = url.parse(reqUrl, true);
                        console.log("Parsed URL:", parsedUrl.pathname, "Query:", JSON.stringify(parsedUrl.query));

                        if (parsedUrl.pathname === "/oauth2callback")
                        {
                            // Send a response to the browser
                            res.writeHead(200, { "Content-Type": "text/html" });

                            const htmlResponse = `
                                <html>
                                <head>
                                    <title>Authentication completed</title>
                                    <style>
                                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                                        h1 { color: #4285f4; }
                                        p { margin: 20px 0; }
                                        .status { font-weight: bold; }
                                        .instructions { background-color: #f1f1f1; padding: 15px; border-radius: 5px; margin: 20px 0; text-align: left; }
                                        .cmd { background-color: #e0e0e0; padding: 3px 6px; border-radius: 3px; font-family: monospace; }
                                    </style>
                                </head>
                                <body>
                                    <h1>Authentication completed</h1>
                                    <p>L'autenticazione a Google Drive è stata completata con successo!</p>
                                    
                                    <div class="instructions">
                                        <p><strong>Cosa succederà ora:</strong></p>
                                        <ol>
                                            <li>Torna a Cursor</li>
                                            <li>L'operazione interrotta riprenderà automaticamente</li>
                                            <li>Se l'operazione non riprende entro pochi secondi, puoi anche eseguire manualmente il comando di upload o download</li>
                                        </ol>
                                    </div>
                                    
                                    <p class="status">Status: <span id="status">Autenticazione completata con successo</span></p>
                                    
                                    <script>
                                        // Questa pagina di callback è puramente informativa
                                        setTimeout(() => {
                                            document.getElementById('status').textContent = 
                                                'Puoi chiudere questa finestra e tornare a Cursor';
                                        }, 2000);
                                    </script>
                                </body>
                                </html>
                            `;

                            res.end(htmlResponse);
                            console.log("Sent HTML response to browser");

                            const code = parsedUrl.query.code;
                            if (code)
                            {
                                // Got the auth code, resolve the promise
                                console.log("Received auth code, resolving promise");
                                resolve(code as string);

                                // Close the server after a short delay to ensure the response is sent
                                setTimeout(() =>
                                {
                                    console.log("Closing OAuth server");
                                    server.close();
                                }, 1000);
                            }
                            else if (parsedUrl.query.error)
                            {
                                // Authentication failed
                                const error = parsedUrl.query.error || "unknown";
                                console.error("Authentication error:", error);
                                reject(new Error(`Authorization failed: ${error}`));
                                server.close();
                            }
                        }
                        else
                        {
                            // Handle other requests (like favicon.ico)
                            res.writeHead(404);
                            res.end();
                        }
                    }
                    catch (err)
                    {
                        console.error("Error handling request:", err);
                        reject(err);
                        server.close();
                    }
                });

                // Start the server on the configured port
                server.listen(OAUTH_SERVER_PORT, () =>
                {
                    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
                    console.log(`OAuth callback server is running on http://localhost:${OAUTH_SERVER_PORT}`);
                });

                // Add a timeout to close the server if not used
                setTimeout(() =>
                {
                    if (server.listening)
                    {
                        server.close();
                        reject(new Error(localize("error.auth.timeout")));
                    }
                }, 5 * 60 * 1000); // 5 minutes timeout
            });

            // Open the URL in the browser
            console.log("Attempting to open browser with URL:", authUrl);
            try
            {
                const success = await vscode.env.openExternal(vscode.Uri.parse(authUrl));

                if (!success)
                {
                    console.error("Failed to open browser automatically");
                    throw new Error(localize("error.browser.open"));
                }

                console.log("Browser opened successfully");

                // Show a message to the user
                vscode.window.showInformationMessage(
                    localize("toast.google.auth.browser.opened"),
                    localize("button.copy.url")
                ).then(selection =>
                {
                    if (selection === localize("button.copy.url"))
                    {
                        vscode.env.clipboard.writeText(authUrl);
                        vscode.window.showInformationMessage(localize("toast.url.copied"));
                    }
                });
            }
            catch (openError)
            {
                console.error("Error opening browser:", openError);

                // In caso di errore nell'apertura del browser, mostriamo un messaggio con opzione di copiare l'URL
                const copyUrl = localize("button.copy.url");
                const openBrowser = "Open URL manually";

                vscode.window.showErrorMessage(
                    `Failed to open browser automatically. Please open this URL manually: ${authUrl.substring(0, 50)}...`,
                    copyUrl,
                    openBrowser
                ).then(selection =>
                {
                    if (selection === copyUrl)
                    {
                        vscode.env.clipboard.writeText(authUrl);
                        vscode.window.showInformationMessage(localize("toast.url.copied"));
                    }
                    else if (selection === openBrowser)
                    {
                        vscode.env.openExternal(vscode.Uri.parse(authUrl));
                    }
                });
            }

            // Wait for the auth code
            console.log("Waiting for auth code from callback...");
            const authCode = await authCodePromise;

            // Exchange the auth code for a refresh token
            console.log("Received auth code, requesting refresh token...");
            const refreshToken = await this.getRefreshToken(authCode);
            console.log("Refresh token successfully obtained");

            // Show success message
            vscode.window.showInformationMessage(localize("toast.google.auth.success"));

            // Update the instance's refresh token
            this._refreshToken = refreshToken;

            // Salva il token e riprendi automaticamente l'operazione
            try
            {
                // Importa l'oggetto Syncing per aggiornare le impostazioni
                const { Syncing } = require("../core");
                const syncing = Syncing.create();

                // Carica le impostazioni attuali
                const settings = syncing.loadSettings();

                // Aggiorna il token di refresh
                settings.google_refresh_token = refreshToken;

                // Salva le impostazioni aggiornate
                await syncing.saveSettings(settings);
                console.log("Refresh token saved to settings");

                // Controlla l'operazione precedente
                const lastOperation = syncing.getLastRequestedOperation();
                console.log("Last operation was:", lastOperation);

                if (lastOperation)
                {
                    // Ottieni oggetti necessari per riprendere direttamente l'operazione

                    // Visualizza un messaggio informativo
                    vscode.window.showInformationMessage(
                        localize("toast.google.auth.success")
                    );

                    // Invece di usare executeCommand, usa un timeout per garantire che il token
                    // sia stato salvato e lo stato di _isSynchronizing sia stato resettato
                    console.log("Setting timer to resume operation automatically");
                    setTimeout(() =>
                    {
                        try
                        {
                            // Ripristina l'operazione in modo diretto
                            vscode.commands.executeCommand(`syncing.${lastOperation}Settings`);
                        }
                        catch (cmdError)
                        {
                            console.error("Error executing command:", cmdError);

                            // Mostra un messaggio che suggerisce di riprovare manualmente
                            vscode.window.showInformationMessage(
                                "L'operazione non è stata ripresa automaticamente. " +
                                `Per favore esegui manualmente il comando Syncing: ${lastOperation === "upload" ? "Upload" : "Download"} Settings.`
                            );
                        }
                    }, 1500); // Attendi 1.5 secondi per garantire che tutto sia pronto
                }
            }
            catch (saveError)
            {
                console.error("Error saving refresh token:", saveError);
                // Continuiamo comunque, l'utente dovrà autenticarsi di nuovo
            }
        }
        catch (err: any)
        {
            console.error("Authentication error:", err);
            throw this._createError(err);
        }
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
            console.log("Exchanging auth code for tokens...");
            const { tokens } = await this._auth.getToken(authCode);
            console.log("Received tokens from Google:", Object.keys(tokens).join(", "));

            this._auth.setCredentials(tokens);
            this._refreshToken = tokens.refresh_token;

            if (!tokens.refresh_token)
            {
                console.error("No refresh token in Google response");
                throw createError(localize("error.no.refresh.token"), 401);
            }

            return tokens.refresh_token;
        }
        catch (err: any)
        {
            console.error("Error getting refresh token:", err);
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

            const files = response.data?.files || [];
            console.log(`Found ${files.length} files in Google Drive folder`);

            // Get content for each file
            const driveFiles: IRemoteFiles = {};
            for (const file of files)
            {
                if (file.id && file.name)
                {
                    console.log(`Processing file: ${file.name}, ID: ${file.id}, MIME type: ${file.mimeType || "unknown"}`);
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
     * Gets the settings folder from Google Drive.
     * Creates it if it doesn't exist.
     *
     * @param forceCreate Se true, crea sempre una nuova cartella invece di cercare una esistente
     * @returns L'ID della cartella trovata o creata
     */
    public async getOrCreateFolder(forceCreate: boolean = false): Promise<string>
    {
        // Se forceCreate è false, riusa il metodo privato esistente
        if (!forceCreate)
        {
            return this._getOrCreateFolder();
        }

        if (!this._auth)
        {
            throw createError(localize("error.check.google.credentials"), 401);
        }

        const drive = google.drive({ version: "v3", auth: this._auth });

        try
        {
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
     * Lists all available Syncing folders in Google Drive.
     * @returns Promise with an array of folder objects containing id and name
     */
    public async listFolders(): Promise<Array<{ id: string; name: string; date: string }>>
    {
        if (!this._auth)
        {
            throw createError(localize("error.check.google.credentials"), 401);
        }

        const drive = google.drive({ version: "v3", auth: this._auth });

        try
        {
            // Escape special characters in the folder name
            const escapedFolderName = GoogleDrive._escapeQueryString(GoogleDrive.FOLDER_NAME);

            // Search for all folders that match our pattern or contain "Syncing" in the name
            const response = await drive.files.list({
                q: `mimeType='application/vnd.google-apps.folder' and (name='${escapedFolderName}' or name contains 'Syncing') and trashed=false`,
                spaces: "drive",
                fields: "files(id, name, modifiedTime, createdTime)"
            });

            const folders = response.data?.files || [];

            // Map to a simpler format with formatted dates
            return folders.map(folder =>
            {
                // Use the most recent date (modified or created)
                const dateStr = folder.modifiedTime || folder.createdTime || "";
                const date = dateStr ? new Date(dateStr).toLocaleString() : "";

                return {
                    id: folder.id || "",
                    name: folder.name || "",
                    date
                };
            });
        }
        catch (err: any)
        {
            console.error("Error listing Google Drive folders:", err);
            throw this._createError(err);
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

            const files = response.data?.files || [];
            if (files.length > 0 && files[0].id)
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

            const fileName = metadata.data.name || "";
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

            if (isStateDB || isBinary || isContentTypeBinary)
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

            const files = response.data?.files || [];
            const isStateDB = setting.type === SettingType.StateDB;

            let fileContent: string | Buffer = setting.content || "";
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
            return createError(`Invalid Value: ${error.message || "Unknown error"}`, error.code);
        }

        return createError(error.message || localize("error.check.google.credentials"), error.code || 500);
    }
}
