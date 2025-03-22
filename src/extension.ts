import type { ExtensionContext } from "vscode";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

import { Syncing, VSCodeSetting, AutoSyncService } from "./core";
import { localize, setup } from "./i18n";
import { registerCommand } from "./utils/vscodeAPI";
import { StorageProvider, SettingType } from "./types";
import * as Toast from "./core/Toast";
import { isAfter } from "./utils/date";
import type { ISyncedItem } from "./types";
import { SyncTracker } from "./core/SyncTracker";
import { Environment } from "./core/Environment";
import type { ISetting } from "./types";
import { StateDBManager } from "./core/StateDBManager";

let _env: Environment;
let _syncing: Syncing;
let _vscodeSetting: VSCodeSetting;
let _autoSyncService: AutoSyncService;
let _isReady: boolean = false;
let _isSynchronizing: boolean = false;

export async function activate(context: ExtensionContext) {
    console.log("[DEBUG] Attivazione dell'estensione Syncing-All");

    // Check and apply any pending state.vscdb changes
    try {
        await StateDBManager.getInstance().checkAndApplyTempStateDB();
    } catch (error) {
        console.error("Error applying state.vscdb changes:", error);
    }

    _initCommands(context);
    _initSyncing(context);
    _initAutoSync();

    // Aggiungi un comando per resettare lo stato di sincronizzazione (utile in caso di problemi)
    context.subscriptions.push(
        registerCommand(context, "syncing.resetSyncState", () => {
            _isSynchronizing = false;
            vscode.window.showInformationMessage("Stato di sincronizzazione resettato. Puoi ora riprovare l'operazione.");
        })
    );

    // L'URI handler rimane per compatibilità, ma non tenta più di riprendere l'operazione
    context.subscriptions.push(
        vscode.window.registerUriHandler({
            handleUri(uri: vscode.Uri): void {
                console.log("URI handler called with:", uri.toString());

                // Extract the path part from URI - works with both cursor:// and vscode://
                const uriPath = uri.path;

                // If we're in the middle of OAuth flow (from the oauth2callback path)
                if (uriPath === "/oauth2callback") {
                    console.log("OAuth callback received - but no action taken, using direct approach instead");

                    // Resetta il flag di sincronizzazione per sicurezza
                    _isSynchronizing = false;
                }
            }
        })
    );
}

export function deactivate() {
    console.log("[DEBUG] Disattivazione dell'estensione Syncing-All");
    _stopAutoSyncService();
}

/**
 * Init commands.
 */
function _initCommands(context: ExtensionContext) {
    console.log("[DEBUG] Inizializzazione dei comandi dell'estensione");
    // Register upload command.
    context.subscriptions.push(
        registerCommand(context, "syncing.uploadSettings", async () => {
            if (!_isReady || _isSynchronizing) {
                console.log(`[DEBUG] Upload non avviato: _isReady=${_isReady}, _isSynchronizing=${_isSynchronizing}`);
                return;
            }

            try {
                console.log("[DEBUG] Inizio dell'operazione di upload");
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

                // 2. Aggiungi il file di tracking alla lista dei file da sincronizzare
                const syncTracker = SyncTracker.create();
                const trackerContent = syncTracker.getContent();

                // Aggiungi il file di tracking come un'impostazione speciale
                const trackerSetting = {
                    type: SettingType.Settings,
                    localFilePath: path.join(_env.userDirectory, "sync-tracker.json"),
                    remoteFilename: syncTracker.remoteFilename,
                    content: trackerContent
                } as ISetting;

                // Aggiungi il tracker alle impostazioni filtrate
                filteredSettings.push(trackerSetting);

                // 3. Upload settings.
                const syncingSettings = _syncing.loadSettings();

                // Check storage provider and call appropriate upload method
                if (syncingSettings.storage_provider === StorageProvider.GoogleDrive) {
                    console.log("[DEBUG] Utilizzo storage provider: Google Drive");
                    // Utilizziamo sempre Google Drive
                    const googleDriveClient = _syncing.getGoogleDriveClient();

                    // Verifica se abbiamo un refresh token, se no, inizia il flusso di autenticazione
                    if (!syncingSettings.google_refresh_token) {
                        await googleDriveClient.authenticate();

                        // Dopo l'autenticazione, salvare il refresh token nelle impostazioni
                        if (googleDriveClient.refreshToken) {
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
                    if (!syncingSettings.id) {
                        try {
                            // Mostra la lista delle cartelle disponibili
                            const folderId = await Toast.showGoogleDriveFolderListBox(googleDriveClient, true);
                            if (folderId) {
                                // Salva l'ID nella configurazione
                                syncingSettings.id = folderId;
                                await _syncing.saveSettings(syncingSettings);
                                Toast.statusInfo(localize("toast.google.folder.selected"));
                            }
                            else {
                                throw new Error(localize("error.no.folder.id"));
                            }
                        }
                        catch (err) {
                            if (err.message === localize("error.abort.synchronization")) {
                                _isSynchronizing = false;
                                return;
                            }
                            throw err;
                        }
                    }

                    try {
                        // Carica le impostazioni su Google Drive
                        const storage = await googleDriveClient.uploadSettings(filteredSettings, true);

                        // Salviamo solo l'ID della cartella nelle impostazioni di Syncing
                        if (syncingSettings.id !== storage.id) {
                            syncingSettings.id = storage.id;
                            await _syncing.saveSettings(syncingSettings);
                        }

                        // Aggiorna il SyncTracker con i contenuti caricati
                        const uploadedFiles: Record<string, string | Buffer> = {};
                        for (const setting of filteredSettings) {
                            if (setting.content && setting.remoteFilename) {
                                uploadedFiles[setting.remoteFilename] = setting.content;
                            }
                        }

                        // Aggiorna lo stato di sincronizzazione
                        const uploadSyncTracker = SyncTracker.create();
                        uploadSyncTracker.updateSyncState(uploadedFiles);
                        console.log("[DEBUG] SyncTracker: Stato aggiornato dopo upload completato");

                        Toast.statusInfo(localize("toast.settings.uploaded"));

                        // Aggiorna il timestamp dell'ultimo upload manuale
                        _autoSyncService.updateLastUploadTime();
                    }
                    catch (err) {
                        // Controllo se l'errore è un "invalid_grant" e richiedi nuova autenticazione
                        if (err.message && (err.message.includes("invalid_grant") || err.code === 401)) {
                            // Il token è scaduto o non valido, rimuoverlo e richiedere l'autenticazione
                            syncingSettings.google_refresh_token = "";
                            await _syncing.saveSettings(syncingSettings);

                            // Mostra messaggio all'utente
                            Toast.statusInfo(localize("toast.google.auth.token.expired"));

                            try {
                                // Riavvia l'autenticazione
                                const refreshGoogleDrive = _syncing.getGoogleDriveClient();
                                await refreshGoogleDrive.authenticate();

                                // Salva il nuovo token
                                if (refreshGoogleDrive.refreshToken) {
                                    syncingSettings.google_refresh_token = refreshGoogleDrive.refreshToken;
                                    await _syncing.saveSettings(syncingSettings);
                                    Toast.statusInfo(localize("toast.google.auth.success"));

                                    // La ripresa automatica dell'operazione viene gestita da GoogleDrive.authenticate()
                                }
                            }
                            catch (authErr) {
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
                else {
                    console.log("[DEBUG] Utilizzo storage provider: Google Drive");
                    // Utilizziamo sempre Google Drive
                    const googleDriveClient = _syncing.getGoogleDriveClient();

                    // Verifica se abbiamo un refresh token, se no, inizia il flusso di autenticazione
                    if (!syncingSettings.google_refresh_token) {
                        await googleDriveClient.authenticate();

                        // Dopo l'autenticazione, salvare il refresh token nelle impostazioni
                        if (googleDriveClient.refreshToken) {
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
                    if (!syncingSettings.id) {
                        try {
                            // Mostra la lista delle cartelle disponibili
                            const folderId = await Toast.showGoogleDriveFolderListBox(googleDriveClient, false);
                            if (folderId) {
                                // Salva l'ID nella configurazione
                                syncingSettings.id = folderId;
                                await _syncing.saveSettings(syncingSettings);
                                Toast.statusInfo(localize("toast.google.folder.selected"));
                            }
                            else {
                                throw new Error(localize("error.no.folder.id"));
                            }
                        }
                        catch (err) {
                            if (err.message === localize("error.abort.synchronization")) {
                                _isSynchronizing = false;
                                return;
                            }
                            throw err;
                        }
                    }

                    try {
                        console.log("[DEBUG] Recupero delle impostazioni remote da Google Drive");
                        const downloadedRemoteSettings = await googleDriveClient.getFiles(true);

                        // Se si tratta di un download manuale, non fare ulteriori controlli
                        // e scarica sempre i file
                        console.log("[DEBUG] Download manuale: bypasso il controllo delle date");

                        // 2. Download settings.
                        const syncedItems = await _vscodeSetting.saveSettings(downloadedRemoteSettings, true);

                        Toast.statusInfo(_getSyncingCompleteMessage(syncedItems));

                        // 3. Restart window (after "synced").
                        await _showRestartPrompt();
                    }
                    catch (err) {
                        // Controllo se l'errore è un "invalid_grant" e richiedi nuova autenticazione
                        if (err.message && (err.message.includes("invalid_grant") || err.code === 401)) {
                            // Il token è scaduto o non valido, rimuoverlo e richiedere l'autenticazione
                            syncingSettings.google_refresh_token = "";
                            await _syncing.saveSettings(syncingSettings);

                            // Mostra messaggio all'utente
                            Toast.statusInfo(localize("toast.google.auth.token.expired"));

                            try {
                                // Riavvia l'autenticazione
                                const refreshGoogleDrive = _syncing.getGoogleDriveClient();
                                await refreshGoogleDrive.authenticate();

                                // Salva il nuovo token
                                if (refreshGoogleDrive.refreshToken) {
                                    syncingSettings.google_refresh_token = refreshGoogleDrive.refreshToken;
                                    await _syncing.saveSettings(syncingSettings);
                                    Toast.statusInfo(localize("toast.google.auth.success"));

                                    // La ripresa automatica dell'operazione viene gestita da GoogleDrive.authenticate()
                                }
                            }
                            catch (authErr) {
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

                // Aggiorna il timestamp dell'ultimo upload manuale
                console.log("[DEBUG] Aggiornamento del timestamp dell'ultimo upload");
                _autoSyncService.updateLastUploadTime();
            }
            catch (err: any) {
                console.log("[DEBUG] Errore durante l'upload:", err);
                console.error("Syncing:", err);
                Toast.statusError(err.message);
            }
            finally {
                console.log("[DEBUG] Fine dell'operazione di upload, reset di _isSynchronizing");
                _isSynchronizing = false;
            }
        })
    );

    // Register download command.
    context.subscriptions.push(
        registerCommand(context, "syncing.downloadSettings", async () => {
            if (!_isReady || _isSynchronizing) {
                console.log(`[DEBUG] Download non avviato: _isReady=${_isReady}, _isSynchronizing=${_isSynchronizing}`);
                return;
            }

            try {
                _isSynchronizing = true;

                // Set the last requested operation
                _syncing.setLastRequestedOperation("download");

                // Show starting download toast
                Toast.statusInfo(localize("toast.settings.downloading"));

                const syncingSettings = _syncing.loadSettings();
                let shouldDownload = true; // Default a true se non possiamo controllare

                // Check storage provider and call appropriate download method
                if (syncingSettings.storage_provider === StorageProvider.GoogleDrive) {
                    // Use Google Drive
                    const googleDriveClient = _syncing.getGoogleDriveClient();

                    // Check if we have a refresh token, if not, initiate the auth flow
                    if (!syncingSettings.google_refresh_token) {
                        await googleDriveClient.authenticate();

                        // Dopo l'autenticazione, salvare il refresh token nelle impostazioni
                        if (googleDriveClient.refreshToken) {
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

                    try {
                        console.log("[DEBUG] Recupero delle impostazioni remote da Google Drive");
                        const downloadedRemoteSettings = await googleDriveClient.getFiles(true);

                        // Prima gestione del file di tracking, se presente
                        const syncTracker = SyncTracker.create();
                        if (downloadedRemoteSettings.files && downloadedRemoteSettings.files[syncTracker.remoteFilename]) {
                            console.log("[DEBUG] Trovato file di tracking remoto");
                            // Aggiorna lo stato locale con il contenuto remoto
                            syncTracker.updateFromRemote(downloadedRemoteSettings.files[syncTracker.remoteFilename].content);
                        }

                        // Se si tratta di un download manuale, bypassa il controllo della data
                        // e scarica sempre i file
                        const isManualDownload = true; // Il comando è stato invocato manualmente dall'utente

                        if (isManualDownload) {
                            console.log("[DEBUG] Download manuale: bypasso il controllo delle date");
                            shouldDownload = true;
                        }
                        else {
                            // Verifica se le impostazioni remote sono più recenti di quelle locali
                            console.log("[DEBUG] Controllo se le impostazioni remote sono più recenti delle locali");
                            const driveSettings = VSCodeSetting.create();
                            const localSettings = await driveSettings.getSettings();
                            const localLastModified = driveSettings.getLastModified(localSettings);
                            const remoteLastModified = new Date(downloadedRemoteSettings.updated_at).getTime();

                            console.log("[DEBUG] Data modifica locale:", new Date(localLastModified).toISOString());
                            console.log("[DEBUG] Data modifica remota:", new Date(remoteLastModified).toISOString());

                            shouldDownload = isAfter(remoteLastModified, localLastModified);
                            console.log("[DEBUG] Le impostazioni remote sono più recenti:", shouldDownload);
                        }

                        if (!shouldDownload) {
                            Toast.statusInfo(localize("toast.settings.autoSync.nothingChanged"));
                            _isSynchronizing = false;
                            return;
                        }

                        // 2. Download settings.
                        const syncedItems = await _vscodeSetting.saveSettings(downloadedRemoteSettings, true);

                        Toast.statusInfo(_getSyncingCompleteMessage(syncedItems));

                        // 3. Restart window (after "synced").
                        await _showRestartPrompt();
                    }
                    catch (err) {
                        // Controllo se l'errore è un "invalid_grant" e richiedi nuova autenticazione
                        if (err.message && (err.message.includes("invalid_grant") || err.code === 401)) {
                            // Il token è scaduto o non valido, rimuoverlo e richiedere l'autenticazione
                            syncingSettings.google_refresh_token = "";
                            await _syncing.saveSettings(syncingSettings);

                            // Mostra messaggio all'utente
                            Toast.statusInfo(localize("toast.google.auth.token.expired"));

                            try {
                                // Riavvia l'autenticazione
                                const refreshGoogleDrive = _syncing.getGoogleDriveClient();
                                await refreshGoogleDrive.authenticate();

                                // Salva il nuovo token
                                if (refreshGoogleDrive.refreshToken) {
                                    syncingSettings.google_refresh_token = refreshGoogleDrive.refreshToken;
                                    await _syncing.saveSettings(syncingSettings);
                                    Toast.statusInfo(localize("toast.google.auth.success"));

                                    // La ripresa automatica dell'operazione viene gestita da GoogleDrive.authenticate()
                                }
                            }
                            catch (authErr) {
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
                else {
                    // Utilizziamo sempre Google Drive
                    const googleDriveClient = _syncing.getGoogleDriveClient();

                    // Verifica se abbiamo un refresh token, se no, inizia il flusso di autenticazione
                    if (!syncingSettings.google_refresh_token) {
                        await googleDriveClient.authenticate();

                        // Dopo l'autenticazione, salvare il refresh token nelle impostazioni
                        if (googleDriveClient.refreshToken) {
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
                    if (!syncingSettings.id) {
                        try {
                            // Mostra la lista delle cartelle disponibili
                            const folderId = await Toast.showGoogleDriveFolderListBox(googleDriveClient, false);
                            if (folderId) {
                                // Salva l'ID nella configurazione
                                syncingSettings.id = folderId;
                                await _syncing.saveSettings(syncingSettings);
                                Toast.statusInfo(localize("toast.google.folder.selected"));
                            }
                            else {
                                throw new Error(localize("error.no.folder.id"));
                            }
                        }
                        catch (err) {
                            if (err.message === localize("error.abort.synchronization")) {
                                _isSynchronizing = false;
                                return;
                            }
                            throw err;
                        }
                    }

                    try {
                        console.log("[DEBUG] Recupero delle impostazioni remote da Google Drive");
                        const downloadedRemoteSettings = await googleDriveClient.getFiles(true);

                        // Se si tratta di un download manuale, non fare ulteriori controlli
                        // e scarica sempre i file
                        console.log("[DEBUG] Download manuale: bypasso il controllo delle date");

                        // 2. Download settings.
                        const syncedItems = await _vscodeSetting.saveSettings(downloadedRemoteSettings, true);

                        Toast.statusInfo(_getSyncingCompleteMessage(syncedItems));

                        // 3. Restart window (after "synced").
                        await _showRestartPrompt();
                    }
                    catch (err) {
                        // Controllo se l'errore è un "invalid_grant" e richiedi nuova autenticazione
                        if (err.message && (err.message.includes("invalid_grant") || err.code === 401)) {
                            // Il token è scaduto o non valido, rimuoverlo e richiedere l'autenticazione
                            syncingSettings.google_refresh_token = "";
                            await _syncing.saveSettings(syncingSettings);

                            // Mostra messaggio all'utente
                            Toast.statusInfo(localize("toast.google.auth.token.expired"));

                            try {
                                // Riavvia l'autenticazione
                                const refreshGoogleDrive = _syncing.getGoogleDriveClient();
                                await refreshGoogleDrive.authenticate();

                                // Salva il nuovo token
                                if (refreshGoogleDrive.refreshToken) {
                                    syncingSettings.google_refresh_token = refreshGoogleDrive.refreshToken;
                                    await _syncing.saveSettings(syncingSettings);
                                    Toast.statusInfo(localize("toast.google.auth.success"));

                                    // La ripresa automatica dell'operazione viene gestita da GoogleDrive.authenticate()
                                }
                            }
                            catch (authErr) {
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
            }
            catch (err: any) {
                Toast.statusError(err.message);
            }
            finally {
                _isSynchronizing = false;
            }
        })
    );

    // Register open settings command.
    context.subscriptions.push(
        registerCommand(context, "syncing.openSettings", () => {
            if (!_isReady) {
                return;
            }

            _syncing.openSettings();
        })
    );

    // Register restore single file version command
    context.subscriptions.push(
        registerCommand(context, "syncing.restoreFileVersion", async () => {
            if (!_isReady || _isSynchronizing) {
                console.log(`[DEBUG] Restore file version non avviato: _isReady=${_isReady}, _isSynchronizing=${_isSynchronizing}`);
                return;
            }

            try {
                console.log("[DEBUG] Inizio dell'operazione di restore file version");
                _isSynchronizing = true;

                // Get the Google Drive client
                const googleDrive = _syncing.getGoogleDriveClient();

                // Show file selection quickpick
                const fileSelection = await Toast.showFileSelectQuickPick(googleDrive);
                if (!fileSelection) {
                    _isSynchronizing = false;
                    return;
                }

                // Show revisions quickpick for the selected file
                const revisionSelection = await Toast.showRevisionsQuickPick(
                    googleDrive,
                    fileSelection.fileId,
                    fileSelection.filename
                );

                if (!revisionSelection) {
                    _isSynchronizing = false;
                    return;
                }

                // Show progress notification
                Toast.statusInfo(localize("toast.settings.restoring.file", fileSelection.filename));

                // Restore the selected file revision
                await _syncing.restoreFileRevision(
                    revisionSelection.fileId,
                    revisionSelection.revisionId,
                    revisionSelection.filename
                );

                // Show success notification
                Toast.statusInfo(localize("toast.settings.restoring.file.success", fileSelection.filename));

                // Ask if user wants to restart VSCode to apply changes
                await _showRestartPrompt();
            }
            catch (err: any) {
                console.error("[DEBUG] Errore durante il ripristino versione file:", err);
                Toast.statusError(localize("toast.settings.restoring.file.failed", err.message || err));
            }
            finally {
                _isSynchronizing = false;
            }
        })
    );

    // Register restore all settings to date command
    context.subscriptions.push(
        registerCommand(context, "syncing.restoreAllSettingsToDate", async () => {
            if (!_isReady || _isSynchronizing) {
                console.log(`[DEBUG] Restore all settings non avviato: _isReady=${_isReady}, _isSynchronizing=${_isSynchronizing}`);
                return;
            }

            try {
                console.log("[DEBUG] Inizio dell'operazione di restore all settings");
                _isSynchronizing = true;

                // Get the Google Drive client
                const googleDrive = _syncing.getGoogleDriveClient();

                // Show date selection quickpick
                const selectedDate = await Toast.showDatesQuickPick(googleDrive);
                if (!selectedDate) {
                    _isSynchronizing = false;
                    return;
                }

                // Ask for confirmation
                const confirmRestore = await vscode.window.showWarningMessage(
                    localize("toast.settings.restore.date.confirm", selectedDate),
                    { modal: true },
                    localize("toast.settings.restore.date.confirm.yes"),
                    localize("toast.settings.restore.date.confirm.no")
                );

                if (confirmRestore !== localize("toast.settings.restore.date.confirm.yes")) {
                    _isSynchronizing = false;
                    return;
                }

                // Show progress notification
                Toast.statusInfo(localize("toast.settings.restoring.date", selectedDate));

                // Restore all settings to the selected date
                const result = await _syncing.restoreSettingsFromDate(selectedDate);

                if (result.success) {
                    // Show success notification with number of restored files
                    Toast.statusInfo(localize(
                        "toast.settings.restoring.date.success",
                        result.restoredFiles.length,
                        selectedDate
                    ));

                    // Ask if user wants to restart VSCode to apply changes
                    await _showRestartPrompt();
                }
                else {
                    Toast.statusInfo(localize("toast.settings.restoring.date.no.files"));
                }
            }
            catch (err: any) {
                console.error("[DEBUG] Errore durante il ripristino impostazioni:", err);
                Toast.statusError(localize("toast.settings.restoring.date.failed", err.message || err));
            }
            finally {
                _isSynchronizing = false;
            }
        })
    );
}

/**
 * Init `Syncing`.
 */
function _initSyncing(context: ExtensionContext) {
    console.log("[DEBUG] Inizializzazione del modulo Syncing");
    _isReady = false;
    _isSynchronizing = false;

    setup(context.extensionPath);
    Toast.statusInfo(localize("toast.initializing"));

    // Create instances using the static factory methods without arguments
    _env = Environment.create();
    _syncing = Syncing.create();
    _vscodeSetting = VSCodeSetting.create();

    // Initialize settings
    _syncing.initSettings().then(() => {
        const settings = _syncing.loadSettings();
        _isReady = true;
        console.log("[DEBUG] Impostazioni inizializzate con successo, _isReady=true");
        Toast.statusInfo(localize("toast.settings.initialized"));

        console.log("[DEBUG] Controllo configurazioni di auto-sync:");
        console.log("[DEBUG] - settings.auto_sync:", settings.auto_sync);

        // Controlla se l'utente ha abilitato autoSync nelle impostazioni
        const autoSyncEnabled = vscode.workspace.getConfiguration("syncing").get<boolean>("autoSync.enabled", false);
        console.log("[DEBUG] - autoSync.enabled:", autoSyncEnabled);

        // Se auto_sync è abilitato nelle impostazioni di Syncing o autoSync.enabled è abilitato
        if (settings.auto_sync || autoSyncEnabled) {
            console.log("[DEBUG] Auto-sync abilitato nelle impostazioni, avvio del servizio auto-sync");
            // Resume auto sync service if auto sync is enabled.
            _resumeAutoSyncService();
        }
        else {
            console.log("[DEBUG] Auto-sync non abilitato nelle impostazioni");
        }
    }).catch((err: Error) => {
        console.log("[DEBUG] Errore durante l'inizializzazione delle impostazioni:", err);
        console.error(err);
        Toast.statusError(localize("toast.init.failed"));
    });
}

/**
 * Init auto sync service.
 */
function _initAutoSync() {
    console.log("[DEBUG] Inizializzazione del servizio AutoSync");
    _autoSyncService = AutoSyncService.create();

    console.log("[DEBUG] Registrazione eventi per upload/download");
    _autoSyncService.on("upload_settings", async () => {
        console.log("[DEBUG] Evento upload_settings emesso - avvio upload automatico");
        // Verifica se ci sono operazioni in corso prima di eseguire
        if (_isSynchronizing) {
            console.log("[DEBUG] Impossibile eseguire upload - sincronizzazione già in corso");
            return;
        }

        // Controlla se l'estensione è pronta
        if (!_isReady) {
            console.log("[DEBUG] Impossibile eseguire upload - estensione non pronta");
            return;
        }

        console.log("[DEBUG] Esecuzione comando uploadSettings");
        vscode.commands.executeCommand("syncing.uploadSettings");
    });

    _autoSyncService.on("download_settings", () => {
        console.log("[DEBUG] Evento download_settings emesso");
        if (_isSynchronizing || !_isReady) {
            console.log("[DEBUG] Impossibile eseguire download - sincronizzazione in corso o estensione non pronta");
            return;
        }
        console.log("[DEBUG] Esecuzione comando downloadSettings");
        vscode.commands.executeCommand("syncing.downloadSettings");
    });

    // Check if auto-sync is enabled in settings before starting the service
    const settings = _syncing.loadSettings();
    const autoSyncEnabled = vscode.workspace.getConfiguration("syncing").get<boolean>("autoSync.enabled", false);

    if (settings.auto_sync || autoSyncEnabled) {
        console.log("[DEBUG] Auto-sync è abilitato nelle impostazioni, avvio del servizio");
        // Avvia il servizio di auto-sincronizzazione
        console.log("[DEBUG] Avvio del servizio AutoSync");
        _autoSyncService.start();
    }
    else {
        console.log("[DEBUG] Auto-sync non è abilitato nelle impostazioni, non avvio del servizio");
    }

    // FORCE START 1: Avvio forzato del servizio dopo 10 secondi per garantire che si avvii
    setTimeout(() => {
        console.log("[DEBUG] BOOTSTRAP 1: Verifica stato del servizio AutoSync");
        if (_autoSyncService) {
            console.log("[DEBUG] Verifica stato pre-bootstrap:");
            console.log("[DEBUG] - _isReady:", _isReady);
            console.log("[DEBUG] - _isSynchronizing:", _isSynchronizing);
            console.log("[DEBUG] - autoSyncService.isRunning():", _autoSyncService.isRunning());

            // Controlla di nuovo le impostazioni per sicurezza
            const currentSettings = _syncing.loadSettings();
            const isAutoSyncEnabled = vscode.workspace.getConfiguration("syncing").get<boolean>("autoSync.enabled", false);

            // Forza l'avvio solo se auto-sync è abilitato
            if (currentSettings.auto_sync || isAutoSyncEnabled) {
                _autoSyncService.start();
            }
            else {
                console.log("[DEBUG] Auto-sync non abilitato, non forzo l'avvio");
            }

            // Esegui subito un controllo e avvia un upload
            setTimeout(() => {
                console.log("[DEBUG] BOOTSTRAP 2: Emissione forzata eventi di sincronizzazione");
                if (_autoSyncService && _autoSyncService.isRunning()) {
                    // Prima verifica download
                    console.log("[DEBUG] Emissione forzata evento download_settings");
                    vscode.commands.executeCommand("syncing.downloadSettings");

                    // Poi dopo un ritardo, upload
                    setTimeout(() => {
                        console.log("[DEBUG] Emissione forzata evento upload_settings");
                        vscode.commands.executeCommand("syncing.uploadSettings");
                    }, 5000);
                }
            }, 2000);
        }
    }, 10000);

    // FORCE START 2: Timer che periodicamente verifica e riavvia il servizio se necessario
    setInterval(() => {
        // Verifica se l'autoSync è abilitato
        const periodicAutoSyncEnabled = vscode.workspace.getConfiguration("syncing").get<boolean>("autoSync.enabled", false);
        console.log("[DEBUG] Timer di controllo principale:");
        console.log("[DEBUG] - _isReady:", _isReady);
        console.log("[DEBUG] - autoSyncEnabled:", periodicAutoSyncEnabled);
        console.log("[DEBUG] - _autoSyncService:", !!_autoSyncService);
        console.log("[DEBUG] - isRunning:", _autoSyncService ? _autoSyncService.isRunning() : false);

        // Se l'estensione è pronta, autoSync è abilitato, ma il servizio non è in esecuzione
        if (_isReady && periodicAutoSyncEnabled && _autoSyncService && !_autoSyncService.isRunning()) {
            console.log("[DEBUG] BOOTSTRAP PERIODICO: Riavvio forzato del servizio AutoSync");
            _autoSyncService.start();

            // Verifica il risultato dopo l'avvio
            setTimeout(() => {
                console.log("[DEBUG] Verifica dopo riavvio bootstrap periodico:");
                console.log("[DEBUG] - isRunning:", _autoSyncService ? _autoSyncService.isRunning() : false);

                // Se è partito correttamente, esegui subito un controllo
                if (_autoSyncService && _autoSyncService.isRunning() && !_isSynchronizing) {
                    console.log("[DEBUG] Avvio verifiche post-bootstrap");
                    vscode.commands.executeCommand("syncing.downloadSettings");
                }
            }, 2000);
        }
    }, 60000); // Controlla ogni minuto

    // Aggiungi un controllo periodico dello stato
    setInterval(() => {
        console.log("[DEBUG] Controllo periodico stato autosync:");
        console.log("[DEBUG] - _isReady:", _isReady);
        console.log("[DEBUG] - _isSynchronizing:", _isSynchronizing);
        console.log("[DEBUG] - autoSyncService.isRunning():", _autoSyncService.isRunning());

        // Verifica se l'autoSync è abilitato
        const statusCheckAutoSyncEnabled = vscode.workspace.getConfiguration("syncing").get<boolean>("autoSync.enabled", false);
        console.log("[DEBUG] - autoSyncEnabled:", statusCheckAutoSyncEnabled);

        // Se autoSync è abilitato ma il servizio non è in esecuzione, avviarlo
        if (statusCheckAutoSyncEnabled && _isReady && !_isSynchronizing && !_autoSyncService.isRunning()) {
            console.log("[DEBUG] Riavvio automatico del servizio AutoSync");
            _autoSyncService.start();
        }
    }, 30000); // Controlla ogni 30 secondi
}

/**
 * Resume auto sync service.
 */
function _resumeAutoSyncService() {
    console.log("[DEBUG] Tentativo di ripresa del servizio auto-sync");

    // Verifica se il servizio è già stato inizializzato
    if (!_autoSyncService) {
        console.log("[DEBUG] AutoSyncService non ancora inizializzato, avvio inizializzazione");
        _initAutoSync();
        return;
    }

    // Controlla se è in corso una sincronizzazione
    if (_isSynchronizing) {
        console.log("[DEBUG] Impossibile riprendere auto-sync: sincronizzazione in corso (_isSynchronizing=true)");
        // Ritenta tra 5 secondi
        setTimeout(_resumeAutoSyncService, 5000);
        return;
    }

    // Controlla se l'estensione è pronta
    if (!_isReady) {
        console.log("[DEBUG] Estensione non pronta, ritardo avvio auto-sync");
        // Ritenta tra 3 secondi
        setTimeout(_resumeAutoSyncService, 3000);
        return;
    }

    // Il servizio è inizializzato e non c'è sincronizzazione in corso
    if (_autoSyncService && !_autoSyncService.isRunning()) {
        console.log("[DEBUG] Ripresa del servizio auto-sync");
        _autoSyncService.start();

        // Verifica che il servizio sia stato avviato correttamente
        setTimeout(() => {
            console.log("[DEBUG] Verifica avvio auto-sync:");
            console.log("[DEBUG] - autoSyncService.isRunning():", _autoSyncService.isRunning());

            // Se ancora non è in esecuzione, riprova
            if (!_autoSyncService.isRunning()) {
                console.log("[DEBUG] Auto-sync non avviato correttamente, nuovo tentativo");
                _autoSyncService.start();
            }
        }, 1000);
    }
    else {
        console.log(`[DEBUG] Impossibile riprendere il servizio auto-sync: _isReady=${_isReady
            }, _autoSyncService=${!!_autoSyncService
            }, isRunning=${_autoSyncService ? _autoSyncService.isRunning() : false}`);
    }
}

/**
 * Stop auto sync service.
 */
function _stopAutoSyncService() {
    console.log("[DEBUG] Tentativo di arresto del servizio auto-sync");
    if (_autoSyncService && _autoSyncService.isRunning()) {
        console.log("[DEBUG] Arresto del servizio auto-sync");
        _autoSyncService.stop();
    }
    else {
        console.log("[DEBUG] Servizio auto-sync non in esecuzione o non inizializzato");
    }
}

/**
 * Shows restart prompt.
 */
async function _showRestartPrompt(): Promise<void> {
    const reload = localize("toast.settings.show.reload.button.text");
    const result = await vscode.window.showInformationMessage(
        localize("toast.settings.show.reload.message"),
        reload
    );
    if (result === reload) {
        // Use the restartWindow function from vscodeAPI that now performs a full application close
        const { restartWindow } = require("./utils/vscodeAPI");
        restartWindow();
    }
}

/**
 * Gets syncing complete message.
 */
function _getSyncingCompleteMessage(syncedItems: { updated: ISyncedItem[]; removed: ISyncedItem[] }): string {
    const failedItems = [...syncedItems.updated, ...syncedItems.removed].filter((item) => !item.synced);
    if (failedItems.length === 0) {
        return localize("toast.settings.synced");
    }
    else if (failedItems.length === 1) {
        return localize("toast.settings.synced.with.errors.single", failedItems[0].name);
    }
    else if (failedItems.length === 2) {
        return localize("toast.settings.synced.with.errors.double", failedItems[0].name, failedItems[1].name);
    }
    else {
        return localize("toast.settings.synced.with.errors.multiple", failedItems.length);
    }
}
