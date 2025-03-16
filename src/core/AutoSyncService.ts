import { EventEmitter } from "events";
import * as vscode from "vscode";

import { Gist } from "./Gist";
import { GoogleDrive } from "./GoogleDrive";
import { isAfter } from "../utils/date";
import { localize } from "../i18n";
import { SettingsWatcherService, WatcherEvent } from "../watcher";
import { VSCodeSetting } from "./VSCodeSetting";
import { StorageProvider } from "../types";
import * as Toast from "./Toast";
import type { IRemoteStorage, ISyncingSettings } from "../types";

export class AutoSyncService
{
    private static _instance: AutoSyncService;

    private _gistSetting: VSCodeSetting;
    private _watcher: SettingsWatcherService;
    private _running: boolean = false;
    private _eventEmitter: EventEmitter;
    private _timeoutId: NodeJS.Timeout | null = null;
    private _lastUploadTime: number = Date.now();

    private constructor()
    {
        console.log("[DEBUG] AutoSyncService constructor - Inizializzazione servizio");
        this._gistSetting = VSCodeSetting.create();
        this._watcher = new SettingsWatcherService();
        this._eventEmitter = new EventEmitter();
        this._watcher.on(WatcherEvent.ALL, () => { this._handleWatcherEvent(); });

        // Forzare attivazione immediata per il debug
        setTimeout(() =>
        {
            console.log("[DEBUG] Controllo iniziale configurazione upload automatico");
            this._setupTimedUpload();

            // Controllo anche se è attivo dopo setup
            setTimeout(() =>
            {
                console.log("[DEBUG] Stato auto-sync dopo inizializzazione:");
                console.log("[DEBUG] - running:", this._running);
                console.log("[DEBUG] - timerActive:", this._timeoutId !== null);
                console.log("[DEBUG] - autoSyncEnabled:", vscode.workspace.getConfiguration("syncing").get<boolean>("autoSync.enabled", false));
            }, 2000);
        }, 5000);

        // Ascolta i cambiamenti nelle impostazioni
        vscode.workspace.onDidChangeConfiguration(e =>
        {
            if (e.affectsConfiguration("syncing.autoSync"))
            {
                console.log("[DEBUG] Cambio configurazione autoSync rilevato");
                this._setupTimedUpload();

                // Controllo se è attivo dopo setup
                setTimeout(() =>
                {
                    const autoSyncEnabled = vscode.workspace.getConfiguration("syncing").get<boolean>("autoSync.enabled", false);
                    console.log("[DEBUG] Stato dopo cambio configurazione:");
                    console.log("[DEBUG] - autoSyncEnabled:", autoSyncEnabled);
                    console.log("[DEBUG] - running:", this._running);
                    console.log("[DEBUG] - timerActive:", this._timeoutId !== null);
                }, 1000);
            }
        });
    }

    /**
     * Creates an instance of the class `AutoSyncService`.
     */
    public static create(): AutoSyncService
    {
        console.log("[DEBUG] AutoSyncService.create() - Creazione istanza singleton");
        if (!AutoSyncService._instance)
        {
            AutoSyncService._instance = new AutoSyncService();
        }
        return AutoSyncService._instance;
    }

    /**
     * Register an event listener
     *
     * @param event The event to listen for ('upload_settings' or 'download_settings')
     * @param listener The callback function to execute when the event is triggered
     */
    public on(event: string, listener: (...args: any[]) => void): void
    {
        console.log("[DEBUG] AutoSyncService.on() - Registrazione listener per evento:", event);
        this._eventEmitter.on(event, listener);
    }

    /**
     * Check if the auto-sync service is currently running
     */
    public isRunning(): boolean
    {
        return this._running;
    }

    /**
     * Start auto-sync service.
     */
    public start()
    {
        console.log("[DEBUG] AutoSyncService.start() - Avvio servizio auto-sync");
        this._running = true;
        this._watcher.start();

        // Assicura che il timer sia configurato correttamente
        this._setupTimedUpload();

        // Verifica che il timer sia stato configurato
        setTimeout(() =>
        {
            console.log("[DEBUG] Verifica configurazione timer dopo start:");
            console.log("[DEBUG] - running:", this._running);
            console.log("[DEBUG] - timerActive:", this._timeoutId !== null);
        }, 1000);
    }

    /**
     * Pause auto-sync service.
     */
    public pause()
    {
        console.log("[DEBUG] AutoSyncService.pause() - Pausa servizio auto-sync");
        this._running = false;
        this._watcher.pause();
        this._clearTimedUpload();
    }

    /**
     * Resume auto-sync service.
     */
    public resume()
    {
        console.log("[DEBUG] AutoSyncService.resume() - Ripresa servizio auto-sync");
        this._running = true;
        this._watcher.resume();
        this._setupTimedUpload();
    }

    /**
     * Stop auto-sync service.
     */
    public stop()
    {
        console.log("[DEBUG] AutoSyncService.stop() - Arresto servizio auto-sync");
        this._running = false;
        this._watcher.stop();
        this._clearTimedUpload();
    }

    /**
     * Synchronize settings.
     */
    public async synchronize(syncingSettings: ISyncingSettings)
    {
        console.log("[DEBUG] AutoSyncService.synchronize() - Avvio sincronizzazione automatica");

        try
        {
            Toast.showSpinner(localize("toast.settings.autoSync.checkingSettings"));

            // Check if storage provider has valid settings
            if (syncingSettings.storage_provider === StorageProvider.GoogleDrive)
            {
                console.log("[DEBUG] Sincronizzazione con Google Drive");

                if (!syncingSettings.google_client_id || !syncingSettings.google_client_secret || !syncingSettings.google_refresh_token)
                {
                    console.log("[DEBUG] Errore: Credenziali Google Drive mancanti");
                    throw new Error(localize("error.missing.google.credentials"));
                }

                const drive = GoogleDrive.create(
                    syncingSettings.google_client_id,
                    syncingSettings.google_client_secret,
                    syncingSettings.google_refresh_token,
                    syncingSettings.id
                );

                // 1. Check remote settings.
                console.log("[DEBUG] Verifica impostazioni remote su Google Drive");
                const remoteGist = await drive.getFiles();

                // 2. Check if need synchronize.
                console.log("[DEBUG] Controllo necessità di sincronizzazione");
                const shouldSync = await this._shouldSynchronize(remoteGist);

                console.log("[DEBUG] Sincronizzazione necessaria:", shouldSync);

                if (shouldSync)
                {
                    // 3. Synchronize settings.
                    console.log("[DEBUG] Avvio salvataggio impostazioni remote");
                    await this._gistSetting.saveSettings(remoteGist);
                    console.log("[DEBUG] Salvataggio impostazioni completato");
                }
            }
            else
            {
                // GitHub Gist
                console.log("[DEBUG] Sincronizzazione con GitHub Gist");

                if (!syncingSettings.token || !syncingSettings.id)
                {
                    console.log("[DEBUG] Errore: Token o ID GitHub Gist mancanti");
                    throw new Error(localize("error.empty.token.or.id"));
                }

                const api = Gist.create(syncingSettings.token);

                // 1. Check remote settings.
                console.log("[DEBUG] Verifica impostazioni remote su GitHub Gist");
                const remoteGist = await api.get(syncingSettings.id);

                // 2. Check if need synchronize.
                console.log("[DEBUG] Controllo necessità di sincronizzazione");
                const shouldSync = await this._shouldSynchronize(remoteGist);

                console.log("[DEBUG] Sincronizzazione necessaria:", shouldSync);

                if (shouldSync)
                {
                    // 3. Synchronize settings.
                    console.log("[DEBUG] Avvio salvataggio impostazioni remote");
                    await this._gistSetting.saveSettings(remoteGist);
                    console.log("[DEBUG] Salvataggio impostazioni completato");
                }
            }
            console.log("[DEBUG] Sincronizzazione completata senza modifiche");
            Toast.statusInfo(localize("toast.settings.autoSync.nothingChanged"));
        }
        catch (err: any)
        {
            console.log("[DEBUG] Errore durante la sincronizzazione:", err.message);
            throw err;
        }
        return false;
    }

    /**
    * Aggiorna il timestamp dell'ultimo upload
    * Da chiamare quando l'utente esegue un upload manuale
    */
    public updateLastUploadTime()
    {
        const previousTime = this._lastUploadTime;
        this._lastUploadTime = Date.now();

        console.log("[DEBUG] AutoSyncService.updateLastUploadTime() - Aggiornamento timestamp ultimo upload:",
            new Date(previousTime).toISOString(), "->", new Date(this._lastUploadTime).toISOString());
    }


    /**
     * Restituisce lo stato corrente della sincronizzazione automatica per il debug
     */
    public getDebugStatus(): any
    {
        return {
            running: this._running,
            timerActive: this._timeoutId !== null,
            lastUploadTime: new Date(this._lastUploadTime).toISOString(),
            config: {
                autoSyncEnabled: vscode.workspace.getConfiguration("syncing").get<boolean>("autoSync.enabled", false),
                interval: vscode.workspace.getConfiguration("syncing").get<number>("autoSync.interval", 30),
                unit: vscode.workspace.getConfiguration("syncing").get<string>("autoSync.unit", "minutes")
            }
        };
    }


    /**
     * Configura l'upload automatico basato sul tempo
     */
    private _setupTimedUpload()
    {
        console.log("[DEBUG] AutoSyncService._setupTimedUpload() - Configurazione upload automatico");

        // Cancella eventuali timer esistenti
        this._clearTimedUpload();

        // Controlla se l'upload automatico è abilitato
        const config = vscode.workspace.getConfiguration("syncing");
        const autoSyncEnabled = config.get<boolean>("autoSync.enabled", false);

        console.log("[DEBUG] Upload automatico abilitato:", autoSyncEnabled);
        console.log("[DEBUG] Servizio running:", this._running);

        // Imposta il flag running a true se autoSync è abilitato
        if (autoSyncEnabled && !this._running)
        {
            console.log("[DEBUG] Impostazione running=true perché autoSync è abilitato");
            this._running = true;
        }

        if (autoSyncEnabled)
        {
            // Ottieni l'intervallo e l'unità di tempo dalle impostazioni
            const interval = config.get<number>("autoSync.interval", 30);
            const unit = config.get<string>("autoSync.unit", "minutes");

            // Calcola l'intervallo in millisecondi
            let intervalMs = interval * 60 * 1000; // Default è minuti
            if (unit === "hours")
            {
                intervalMs = interval * 60 * 60 * 1000;
            }

            console.log("[DEBUG] Intervallo configurato:", interval, unit, `(${intervalMs}ms)`);

            // Usa un intervallo di controllo più breve per il debug
            const checkInterval = 10000; // 10 secondi per il debug
            console.log("[DEBUG] Intervallo di controllo timer impostato a:", checkInterval, "ms");

            // Imposta il timer per l'upload automatico
            this._timeoutId = setInterval(() =>
            {
                console.log("[DEBUG] Controllo timer upload automatico");
                // Verifica se è passato abbastanza tempo dall'ultimo upload manuale
                const now = Date.now();
                const timeSinceLastUpload = now - this._lastUploadTime;

                console.log("[DEBUG] Tempo dall'ultimo upload:", timeSinceLastUpload, "ms, soglia:", intervalMs, "ms");

                if (timeSinceLastUpload >= intervalMs)
                {
                    console.log("[DEBUG] Avvio upload automatico basato su timer");
                    this._eventEmitter.emit("upload_settings");
                    this._lastUploadTime = now;
                }
                else
                {
                    console.log("[DEBUG] Timer attivo ma non è ancora il momento di eseguire l'upload");
                    console.log("[DEBUG] Prossimo upload tra:", intervalMs - timeSinceLastUpload, "ms");
                }
            }, checkInterval); // Intervallo di controllo più breve per il debug

            console.log("[DEBUG] Timer upload automatico impostato, intervallo di controllo:", checkInterval, "ms");
        }
        else
        {
            console.log("[DEBUG] Upload automatico non abilitato, timer non configurato");
        }
    }

    /**
     * Cancella il timer per l'upload automatico
     */
    private _clearTimedUpload()
    {
        console.log("[DEBUG] AutoSyncService._clearTimedUpload() - Cancellazione timer upload automatico");
        if (this._timeoutId)
        {
            clearInterval(this._timeoutId);
            this._timeoutId = null;
            console.log("[DEBUG] Timer upload automatico cancellato");
        }
    }


    private async _shouldSynchronize(gist: IRemoteStorage): Promise<boolean>
    {
        console.log("[DEBUG] AutoSyncService._shouldSynchronize() - Verifica necessità di sincronizzazione");

        try
        {
            // Gets the last modified time (in milliseconds) of the local settings.
            console.log("[DEBUG] Recupero impostazioni locali");
            const local = await this._gistSetting.getSettings();

            // Gets the last modified time (in milliseconds) of the remote gist.
            const remoteLastModified = new Date(gist.updated_at).getTime();
            console.log("[DEBUG] Data modifica remota:", new Date(remoteLastModified).toISOString());

            // Compares the local and remote settings.
            const localLastModified = this._gistSetting.getLastModified(local);
            console.log("[DEBUG] Data modifica locale:", new Date(localLastModified).toISOString());

            const remoteIsNewer = isAfter(remoteLastModified, localLastModified);
            console.log("[DEBUG] Remoto più recente del locale:", remoteIsNewer);

            if (remoteIsNewer)
            {
                console.log("[DEBUG] Sincronizzazione necessaria: le impostazioni remote sono più recenti");
                return true;
            }
            console.log("[DEBUG] Sincronizzazione non necessaria: le impostazioni locali sono aggiornate");
            return false;
        }
        catch (err: any)
        {
            console.log("[DEBUG] Errore durante il controllo di sincronizzazione:", err.message);
            return false;
        }
    }

    private _handleWatcherEvent()
    {
        console.log("[DEBUG] AutoSyncService._handleWatcherEvent() - Evento watcher rilevato");
        // Emit event to trigger upload
        this._eventEmitter.emit("upload_settings");
        this._lastUploadTime = Date.now();
    }
}
