import type { ExtensionContext } from "vscode";
import * as vscode from "vscode";

import { Syncing, VSCodeSetting, AutoSyncService } from "./core";
import { localize, setup } from "./i18n";
import { registerCommand } from "./utils/vscodeAPI";
import { StorageProvider, SettingType } from "./types";
import * as Toast from "./core/Toast";
import type { ISyncedItem } from "./types";

let _syncing: Syncing;
let _vscodeSetting: VSCodeSetting;
let _autoSyncService: AutoSyncService;
let _isReady: boolean;
let _isSynchronizing: boolean;

export function activate(context: ExtensionContext)
{
    _initCommands(context);
    _initSyncing(context);
    _initAutoSync();

    // Aggiungi un comando per resettare lo stato di sincronizzazione (utile in caso di problemi)
    context.subscriptions.push(
        registerCommand(context, "syncing.resetSyncState", () =>
        {
            _isSynchronizing = false;
            vscode.window.showInformationMessage("Stato di sincronizzazione resettato. Puoi ora riprovare l'operazione.");
        })
    );

    // L'URI handler rimane per compatibilità, ma non tenta più di riprendere l'operazione
    context.subscriptions.push(
        vscode.window.registerUriHandler({
            handleUri(uri: vscode.Uri): void
            {
                console.log("URI handler called with:", uri.toString());

                // Extract the path part from URI - works with both cursor:// and vscode://
                const path = uri.path;

                // If we're in the middle of OAuth flow (from the oauth2callback path)
                if (path === "/oauth2callback")
                {
                    console.log("OAuth callback received - but no action taken, using direct approach instead");

                    // Resetta il flag di sincronizzazione per sicurezza
                    _isSynchronizing = false;
                }
            }
        })
    );
}

export function deactivate()
{
    _stopAutoSyncService();
}

/**
 * Init commands.
 */
function _initCommands(context: ExtensionContext)
{
    // Register upload command.
    context.subscriptions.push(
        registerCommand(context, "syncing.uploadSettings", async () =>
        {
            if (!_isReady || _isSynchronizing)
            {
                return;
            }

            try
            {
                _isSynchronizing = true;

                // Set the last requested operation
                _syncing.setLastRequestedOperation("upload");

                // Show starting upload toast
                Toast.statusInfo(localize("toast.settings.uploading"));

                // 1. Get settings that will be uploaded.
                const settings = await _vscodeSetting.getSettings(true, true);

                // Filter out syncing.json to prevent it from being uploaded
                const filteredSettings = settings.filter(setting =>
                    !(setting.type === SettingType.Settings &&
                        setting.remoteFilename === "syncing.json"));

                // 2. Upload settings.
                const syncingSettings = _syncing.loadSettings();

                // Check storage provider and call appropriate upload method
                if (syncingSettings.storage_provider === StorageProvider.GoogleDrive)
                {
                    // Use Google Drive
                    if (!syncingSettings.google_client_id || !syncingSettings.google_client_secret)
                    {
                        // Show error for missing Google Drive credentials
                        throw new Error(localize("error.missing.google.credentials"));
                    }

                    const googleDriveClient = _syncing.getGoogleDriveClient();

                    // Check if we have a refresh token, if not, initiate the auth flow
                    if (!syncingSettings.google_refresh_token)
                    {
                        await googleDriveClient.authenticate();

                        // Dopo l'autenticazione, salvare il refresh token nelle impostazioni
                        if (googleDriveClient.refreshToken)
                        {
                            syncingSettings.google_refresh_token = googleDriveClient.refreshToken;
                            await _syncing.saveSettings(syncingSettings);

                            // Mostra messaggio di successo all'utente
                            Toast.statusInfo(localize("toast.google.auth.success"));
                        }

                        // IMPORTANTE: imposta _isSynchronizing a false per permettere la ripresa automatica
                        // dell'operazione dal metodo authenticate() di GoogleDrive
                        _isSynchronizing = false;
                        return;
                    }

                    // Se non c'è l'ID della cartella, chiediamo all'utente di selezionarne una o crearne una nuova
                    if (!syncingSettings.id)
                    {
                        try
                        {
                            // Mostra la lista delle cartelle disponibili (con true per upload)
                            const folderId = await Toast.showGoogleDriveFolderListBox(googleDriveClient, true);
                            if (folderId)
                            {
                                // Salva l'ID nella configurazione
                                syncingSettings.id = folderId;
                                await _syncing.saveSettings(syncingSettings);
                                Toast.statusInfo(localize("toast.google.folder.selected"));
                            }
                            else
                            {
                                throw new Error(localize("error.no.folder.id"));
                            }
                        }
                        catch (err)
                        {
                            if (err.message === localize("error.abort.synchronization"))
                            {
                                _isSynchronizing = false;
                                return;
                            }
                            throw err;
                        }
                    }

                    try
                    {
                        // Pass the filtered settings directly to uploadSettings
                        const storage = await googleDriveClient.uploadSettings(filteredSettings, true);

                        // Salviamo solo l'ID della cartella nelle impostazioni di Syncing
                        if (syncingSettings.id !== storage.id)
                        {
                            syncingSettings.id = storage.id;
                            await _syncing.saveSettings(syncingSettings);
                        }

                        Toast.statusInfo(localize("toast.settings.uploaded"));
                    }
                    catch (err)
                    {
                        // Controllo se l'errore è un "invalid_grant" e richiedi nuova autenticazione
                        if (err.message && (err.message.includes("invalid_grant") || err.code === 401))
                        {
                            // Il token è scaduto o non valido, rimuoverlo e richiedere l'autenticazione
                            syncingSettings.google_refresh_token = "";
                            await _syncing.saveSettings(syncingSettings);

                            // Mostra messaggio all'utente
                            Toast.statusInfo(localize("toast.google.auth.token.expired"));

                            try
                            {
                                // Riavvia l'autenticazione
                                const refreshGoogleDrive = _syncing.getGoogleDriveClient();
                                await refreshGoogleDrive.authenticate();

                                // Salva il nuovo token
                                if (refreshGoogleDrive.refreshToken)
                                {
                                    syncingSettings.google_refresh_token = refreshGoogleDrive.refreshToken;
                                    await _syncing.saveSettings(syncingSettings);
                                    Toast.statusInfo(localize("toast.google.auth.success"));

                                    // La ripresa automatica dell'operazione viene gestita da GoogleDrive.authenticate()
                                }
                            }
                            catch (authErr)
                            {
                                console.error("Authentication error:", authErr);
                                Toast.statusError(localize("toast.google.auth.failed", authErr.message));
                            }

                            // IMPORTANTE: imposta _isSynchronizing a false per permettere la ripresa automatica
                            // dell'operazione dal metodo authenticate() di GoogleDrive
                            _isSynchronizing = false;
                            return;
                        }
                        throw err; // Rilancia l'errore se non è un problema di token
                    }
                }
                else
                {
                    // Fallback to Remote Storage
                    const remoteStorageSettings = await _syncing.prepareUploadSettings(true);
                    const remoteStorage = _syncing.getRemoteStorageClient();

                    // 3-1. If it has a Storage ID, try to update it.
                    if (remoteStorageSettings.id != null && remoteStorageSettings.id !== "")
                    {
                        // 3-1-1. Try get the remote storage.
                        const existingStorage = await remoteStorage.exists(remoteStorageSettings.id);
                        if (existingStorage)
                        {
                            // 3-1-2. If it exists, update it.
                            await remoteStorage.findAndUpdate(remoteStorageSettings.id, settings, true, true);
                        }
                        else
                        {
                            // 3-1-3. If it doesn't exist, create a new one.
                            const newStorage = await remoteStorage.createSettings(settings);

                            // Save to Syncing's settings.
                            remoteStorageSettings.id = newStorage.id;
                            await _syncing.saveSettings(remoteStorageSettings);
                        }
                    }
                    else
                    {
                        // 3-2. If no Storage ID, create a new one.
                        const newStorage = await remoteStorage.createSettings(settings);

                        // Save to Syncing's settings.
                        remoteStorageSettings.id = newStorage.id;
                        await _syncing.saveSettings(remoteStorageSettings);
                    }

                    Toast.statusInfo(localize("toast.settings.uploaded"));
                }
            }
            catch (err: any)
            {
                console.error("Syncing:", err);
                Toast.statusError(err.message);
            }
            finally
            {
                _isSynchronizing = false;
            }
        })
    );

    // Register download command.
    context.subscriptions.push(
        registerCommand(context, "syncing.downloadSettings", async () =>
        {
            if (!_isReady || _isSynchronizing)
            {
                return;
            }

            try
            {
                _isSynchronizing = true;

                // Set the last requested operation
                _syncing.setLastRequestedOperation("download");

                // Show starting download toast
                Toast.statusInfo(localize("toast.settings.downloading"));

                const syncingSettings = _syncing.loadSettings();

                // Check storage provider and call appropriate download method
                if (syncingSettings.storage_provider === StorageProvider.GoogleDrive)
                {
                    // Use Google Drive
                    const googleDriveClient = _syncing.getGoogleDriveClient();

                    // Check if we have a refresh token, if not, initiate the auth flow
                    if (!syncingSettings.google_refresh_token)
                    {
                        await googleDriveClient.authenticate();

                        // Dopo l'autenticazione, salvare il refresh token nelle impostazioni
                        if (googleDriveClient.refreshToken)
                        {
                            syncingSettings.google_refresh_token = googleDriveClient.refreshToken;
                            await _syncing.saveSettings(syncingSettings);

                            // Mostra messaggio di successo all'utente
                            Toast.statusInfo(localize("toast.google.auth.success"));
                        }

                        // IMPORTANTE: imposta _isSynchronizing a false per permettere la ripresa automatica
                        // dell'operazione dal metodo authenticate() di GoogleDrive
                        _isSynchronizing = false;
                        return;
                    }

                    // Se non c'è l'ID della cartella, chiediamo all'utente di selezionarne una
                    if (!syncingSettings.id)
                    {
                        try
                        {
                            // Mostra la lista delle cartelle disponibili
                            const folderId = await Toast.showGoogleDriveFolderListBox(googleDriveClient, false);
                            if (folderId)
                            {
                                // Salva l'ID nella configurazione
                                syncingSettings.id = folderId;
                                await _syncing.saveSettings(syncingSettings);
                                Toast.statusInfo(localize("toast.google.folder.selected"));
                            }
                            else
                            {
                                throw new Error(localize("error.no.folder.id"));
                            }
                        }
                        catch (err)
                        {
                            if (err.message === localize("error.abort.synchronization"))
                            {
                                _isSynchronizing = false;
                                return;
                            }
                            throw err;
                        }
                    }

                    try
                    {
                        const remoteSettings = await googleDriveClient.getFiles(true);

                        // 2. Download settings.
                        const syncedItems = await _vscodeSetting.saveSettings(remoteSettings, true);

                        Toast.statusInfo(_getSyncingCompleteMessage(syncedItems));

                        // 3. Restart window (after "synced").
                        await _showRestartPrompt();
                    }
                    catch (err)
                    {
                        // Controllo se l'errore è un "invalid_grant" e richiedi nuova autenticazione
                        if (err.message && (err.message.includes("invalid_grant") || err.code === 401))
                        {
                            // Il token è scaduto o non valido, rimuoverlo e richiedere l'autenticazione
                            syncingSettings.google_refresh_token = "";
                            await _syncing.saveSettings(syncingSettings);

                            // Mostra messaggio all'utente
                            Toast.statusInfo(localize("toast.google.auth.token.expired"));

                            try
                            {
                                // Riavvia l'autenticazione
                                const refreshGoogleDrive = _syncing.getGoogleDriveClient();
                                await refreshGoogleDrive.authenticate();

                                // Salva il nuovo token
                                if (refreshGoogleDrive.refreshToken)
                                {
                                    syncingSettings.google_refresh_token = refreshGoogleDrive.refreshToken;
                                    await _syncing.saveSettings(syncingSettings);
                                    Toast.statusInfo(localize("toast.google.auth.success"));

                                    // La ripresa automatica dell'operazione viene gestita da GoogleDrive.authenticate()
                                }
                            }
                            catch (authErr)
                            {
                                console.error("Authentication error:", authErr);
                                Toast.statusError(localize("toast.google.auth.failed", authErr.message));
                            }

                            // IMPORTANTE: imposta _isSynchronizing a false per permettere la ripresa automatica
                            // dell'operazione dal metodo authenticate() di GoogleDrive
                            _isSynchronizing = false;
                            return;
                        }
                        throw err; // Rilancia l'errore se non è un problema di token
                    }
                }
                else
                {
                    // Fallback to Remote Storage
                    // 1. Get Remote Storage.
                    const remoteStorageSettings = await _syncing.prepareDownloadSettings(true);
                    const remoteStorage = _syncing.getRemoteStorageClient();
                    const remoteSettings = await remoteStorage.get(remoteStorageSettings.id, true);

                    // 2. Download settings.
                    const syncedItems = await _vscodeSetting.saveSettings(remoteSettings, true);

                    Toast.statusInfo(_getSyncingCompleteMessage(syncedItems));

                    // 3. Restart window (after "synced").
                    await _showRestartPrompt();
                }
            }
            catch (err: any)
            {
                Toast.statusError(err.message);
            }
            finally
            {
                _isSynchronizing = false;
            }
        })
    );

    // Register open settings command.
    context.subscriptions.push(
        registerCommand(context, "syncing.openSettings", () =>
        {
            if (!_isReady)
            {
                return;
            }

            _syncing.openSettings();
        })
    );
}

/**
 * Init `Syncing`.
 */
function _initSyncing(context: ExtensionContext)
{
    _isReady = false;
    _isSynchronizing = false;

    setup(context.extensionPath);
    Toast.statusInfo(localize("toast.initializing"));

    // Create instances using the static factory methods without arguments
    _syncing = Syncing.create();
    _vscodeSetting = VSCodeSetting.create();

    // Initialize settings
    _syncing.initSettings().then(() =>
    {
        const settings = _syncing.loadSettings();
        _isReady = true;
        Toast.statusInfo(localize("toast.settings.initialized"));

        if (settings.auto_sync)
        {
            // Resume auto sync service if auto sync is enabled.
            _resumeAutoSyncService();
        }
    }).catch((err: Error) =>
    {
        console.error(err);
        Toast.statusError(localize("toast.init.failed"));
    });
}

/**
 * Init auto sync service.
 */
function _initAutoSync()
{
    _autoSyncService = AutoSyncService.create();
    _autoSyncService.on("upload_settings", () =>
    {
        vscode.commands.executeCommand("syncing.uploadSettings");
    });
    _autoSyncService.on("download_settings", () =>
    {
        vscode.commands.executeCommand("syncing.downloadSettings");
    });
}

/**
 * Resume auto sync service.
 */
function _resumeAutoSyncService()
{
    if (!_isSynchronizing)
    {
        if (_isReady && _autoSyncService && !_autoSyncService.isRunning())
        {
            _autoSyncService.start();
        }
    }
}

/**
 * Stop auto sync service.
 */
function _stopAutoSyncService()
{
    if (_autoSyncService && _autoSyncService.isRunning())
    {
        _autoSyncService.stop();
    }
}

/**
 * Shows restart prompt.
 */
async function _showRestartPrompt(): Promise<void>
{
    const reload = localize("toast.settings.show.reload.button.text");
    const result = await vscode.window.showInformationMessage(
        localize("toast.settings.show.reload.message"),
        reload
    );
    if (result === reload)
    {
        // Use the restartWindow function from vscodeAPI that now performs a full application close
        const { restartWindow } = require("./utils/vscodeAPI");
        restartWindow();
    }
}

/**
 * Gets syncing complete message.
 */
function _getSyncingCompleteMessage(syncedItems: { updated: ISyncedItem[]; removed: ISyncedItem[] }): string
{
    const failedItems = [...syncedItems.updated, ...syncedItems.removed].filter((item) => !item.synced);
    if (failedItems.length === 0)
    {
        return localize("toast.settings.synced");
    }
    else if (failedItems.length === 1)
    {
        return localize("toast.settings.synced.with.errors.single", failedItems[0].name);
    }
    else if (failedItems.length === 2)
    {
        return localize("toast.settings.synced.with.errors.double", failedItems[0].name, failedItems[1].name);
    }
    else
    {
        return localize("toast.settings.synced.with.errors.multiple", failedItems.length);
    }
}
