import { EventEmitter } from "events";
import * as vscode from "vscode";

import { GoogleDrive } from "./GoogleDrive";
import { isAfter } from "../utils/date";
import { localize } from "../i18n";
import { SettingsWatcherService, WatcherEvent } from "../watcher";
import { VSCodeSetting } from "./VSCodeSetting";
import * as Toast from "./Toast";
import { SyncTracker } from "./SyncTracker";
import type { IRemoteStorage, ISyncingSettings } from "../types";

export class AutoSyncService
{
    private static _instance: AutoSyncService;

    private _settingManager: VSCodeSetting;
    private _watcher: SettingsWatcherService;
    private _running: boolean = false;
    private _eventEmitter: EventEmitter;
    private _timeoutId: NodeJS.Timeout | null = null;
    private _lastUploadTime: number = Date.now();
    private _watchdogId: NodeJS.Timeout | null = null;
    private _autoRestartEnabled: boolean = true;

    private constructor()
    {
        console.log("[DEBUG] AutoSyncService constructor - Inizializzazione servizio");
        this._settingManager = VSCodeSetting.create();
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

        // Avvia subito il watchdog per il monitoraggio continuo
        this._startWatchdog();
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

        // Pulisci i timer esistenti prima di ripartire
        this._clearTimers();

        // Resetta _lastUploadTime a un valore che consentirà l'upload quando necessario
        // ma non forzerà un upload immediato all'avvio
        this._lastUploadTime = Date.now();

        // Attiva il watchdog per controllare che il servizio rimanga attivo
        this._setupWatchdog();

        // Configura il timer per gli upload periodici
        this._setupForcedTimedUpload();

        // All'avvio del servizio, verifica solo se ci sono impostazioni remote più recenti
        setTimeout(async () =>
        {
            if (this._running)
            {
                try
                {
                    console.log("[DEBUG] Controllo iniziale per operazioni di sincronizzazione");

                    // Verifica se ci sono impostazioni remote più recenti da scaricare
                    console.log("[DEBUG] Verifica della presenza di impostazioni remote più recenti");
                    this._checkForNewerRemoteSettings();

                    // NON eseguiamo l'upload automatico all'avvio, solo la verifica di download
                    // che includerà già il controllo delle date
                }
                catch (err)
                {
                    console.log("[DEBUG] Errore durante il controllo iniziale:", err);
                    // Non interrompere il servizio in caso di errore
                }
            }
        }, 3000); // Ritardo di 3 secondi per assicurarsi che tutto sia pronto
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

        // Non fermare il watchdog - continuerà a monitorare
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

            // Utilizziamo sempre Google Drive
            console.log("[DEBUG] Sincronizzazione con Google Drive");

            const googleDriveClient = GoogleDrive.create();

            // Verifica se abbiamo un refresh token, se no, non possiamo sincronizzare
            if (!syncingSettings.google_refresh_token)
            {
                console.log("[DEBUG] Errore: Refresh token Google Drive mancante");
                throw new Error(localize("error.missing.google.credentials"));
            }

            // Se non c'è l'ID della cartella, non possiamo sincronizzare
            if (!syncingSettings.id)
            {
                console.log("[DEBUG] Errore: ID cartella Google Drive mancante");
                throw new Error(localize("error.no.folder.id"));
            }

            // 1. Check remote settings.
            console.log("[DEBUG] Verifica impostazioni remote su Google Drive");
            const remoteGist = await googleDriveClient.getFiles();

            // 2. Check if need synchronize.
            console.log("[DEBUG] Controllo necessità di sincronizzazione");
            const shouldSync = await this._shouldSynchronize(remoteGist);

            console.log("[DEBUG] Sincronizzazione necessaria:", shouldSync);

            if (shouldSync)
            {
                // 3. Synchronize settings.
                console.log("[DEBUG] Avvio salvataggio impostazioni remote");
                await this._settingManager.saveSettings(remoteGist);
                console.log("[DEBUG] Salvataggio impostazioni completato");
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
     * Verifica se ci sono impostazioni remote più recenti e avvia il download
     */
    private _checkForNewerRemoteSettings()
    {
        console.log("[DEBUG] AutoSyncService._checkForNewerRemoteSettings() - Verifica impostazioni remote");
        try
        {
            // Emetti l'evento di download che contiene già la logica di controllo della data
            console.log("[DEBUG] Emissione evento download_settings per verifica impostazioni remote");
            this._eventEmitter.emit("download_settings");
        }
        catch (err)
        {
            console.log("[DEBUG] Errore durante la verifica delle impostazioni remote:", err);
        }
    }


    /**
     * Avvia il watchdog che controlla continuamente lo stato del servizio
     * e lo riavvia se necessario
     */
    private _startWatchdog()
    {
        console.log("[DEBUG] AutoSyncService._startWatchdog() - Avvio watchdog per monitoraggio continuo");

        // Ferma eventuali watchdog esistenti
        this._stopWatchdog();

        // Avvia un nuovo watchdog
        this._watchdogId = setInterval(() =>
        {
            try
            {
                const autoSyncEnabled = vscode.workspace.getConfiguration("syncing").get<boolean>("autoSync.enabled", false);
                const settings = vscode.workspace.getConfiguration("syncing").get("settings", {}) as any;
                const settingsAutoSync = settings && settings.auto_sync;

                console.log("[DEBUG] Watchdog - Controllo stato auto-sync:");
                console.log("[DEBUG] - autoSync.enabled:", autoSyncEnabled);
                console.log("[DEBUG] - settings.auto_sync:", settingsAutoSync);
                console.log("[DEBUG] - running:", this._running);
                console.log("[DEBUG] - timerActive:", this._timeoutId !== null);

                // Se autoSync dovrebbe essere attivo ma non lo è
                if ((autoSyncEnabled || settingsAutoSync) && (!this._running || !this._timeoutId))
                {
                    console.log("[DEBUG] Watchdog - Rilevato arresto inatteso di auto-sync, riavvio in corso...");

                    // Forza lo stop per pulire lo stato
                    this._running = false;
                    this._clearTimedUpload();

                    // Riavvia il servizio
                    if (this._autoRestartEnabled)
                    {
                        console.log("[DEBUG] Watchdog - Riavvio automatico del servizio");
                        this._running = true;
                        this._watcher.start();
                        this._setupTimedUpload();

                        // Dopo il riavvio, controlla se è effettivamente partito
                        setTimeout(() =>
                        {
                            if (!this._timeoutId)
                            {
                                console.log("[DEBUG] Watchdog - Riavvio non riuscito, nuovo tentativo tra 60 secondi");
                            }
                            else
                            {
                                console.log("[DEBUG] Watchdog - Riavvio riuscito");
                            }
                        }, 1000);
                    }
                }
            }
            catch (err)
            {
                console.log("[DEBUG] Errore nel watchdog:", err);
                // Non interrompere il watchdog in caso di errore
            }
        }, 15000); // Controlla ogni 15 secondi
    }

    /**
     * Ferma il watchdog
     */
    private _stopWatchdog()
    {
        if (this._watchdogId)
        {
            clearInterval(this._watchdogId);
            this._watchdogId = null;
            console.log("[DEBUG] AutoSyncService._stopWatchdog() - Watchdog fermato");
        }
    }

    /**
     * Imposta forzatamente il timer di upload ignorando tutte le condizioni
     */
    private _setupForcedTimedUpload()
    {
        console.log("[DEBUG] AutoSyncService._setupForcedTimedUpload() - Configurazione upload forzata");

        // Cancella eventuali timer esistenti
        this._clearTimedUpload();

        // Ottieni l'intervallo configurato nelle impostazioni
        const config = vscode.workspace.getConfiguration("syncing");
        const interval = config.get<number>("autoSync.interval", 30);
        const unit = config.get<string>("autoSync.unit", "minutes");

        // Calcola l'intervallo in millisecondi per il confronto
        let intervalMs = interval * 60 * 1000; // Default è minuti
        if (unit === "hours")
        {
            intervalMs = interval * 60 * 60 * 1000;
        }

        // Calcola un intervallo di controllo proporzionale all'intervallo configurato
        // L'intervallo di controllo sarà circa 1/10 dell'intervallo configurato
        // Con un minimo di 5 secondi e un massimo di 2 minuti
        let checkInterval = Math.floor(intervalMs / 10);

        // Imposta limiti ragionevoli
        const MIN_CHECK_INTERVAL = 5000; // Minimo 5 secondi
        const MAX_CHECK_INTERVAL = 120000; // Massimo 2 minuti

        if (checkInterval < MIN_CHECK_INTERVAL)
        {
            checkInterval = MIN_CHECK_INTERVAL;
        }
        else if (checkInterval > MAX_CHECK_INTERVAL)
        {
            checkInterval = MAX_CHECK_INTERVAL;
        }

        console.log(`[DEBUG] Configurazione timer: intervallo configurato ${interval} ${unit}, intervallo di controllo: ${checkInterval / 1000} secondi`);

        // Imposta il timer per l'upload automatico
        this._timeoutId = setInterval(() =>
        {
            try
            {
                console.log("[DEBUG] Controllo timer upload automatico");

                // Verifica se è passato abbastanza tempo dall'ultimo upload manuale
                const now = Date.now();
                const timeSinceLastUpload = now - this._lastUploadTime;

                // Calcola il tempo rimanente in minuti e secondi per i log
                const remainingMs = intervalMs - timeSinceLastUpload;
                const remainingMinutes = Math.floor(remainingMs / 60000);
                const remainingSeconds = Math.floor((remainingMs % 60000) / 1000);

                console.log("[DEBUG] -------------------------------------------------");
                console.log(`[DEBUG] INTERVALLO CONFIGURATO: ${interval} ${unit}`);
                console.log(`[DEBUG] Intervallo di controllo: ${checkInterval / 1000} secondi`);
                console.log(`[DEBUG] Tempo trascorso dall'ultimo upload: ${Math.floor(timeSinceLastUpload / 60000)} min ${Math.floor((timeSinceLastUpload % 60000) / 1000)} sec`);

                if (timeSinceLastUpload >= intervalMs)
                {
                    console.log(`[DEBUG] ESECUZIONE UPLOAD: intervallo di ${interval} ${unit} raggiunto!`);
                    this._eventEmitter.emit("upload_settings");
                    this._lastUploadTime = now;
                }
                else
                {
                    console.log(`[DEBUG] PROSSIMO UPLOAD TRA: ${remainingMinutes} min e ${remainingSeconds} sec (basato su impostazione ${interval} ${unit})`);
                }
                console.log("[DEBUG] -------------------------------------------------");
            }
            catch (err)
            {
                console.log("[DEBUG] Errore durante il controllo del timer:", err);
                // Non interrompere il timer in caso di errore
            }
        }, checkInterval);

        console.log(`[DEBUG] Timer upload automatico impostato con intervallo di controllo: ${checkInterval / 1000} secondi`);
    }

    /**
     * Configura l'upload automatico basato sul tempo
     */
    private _setupTimedUpload()
    {
        console.log("[DEBUG] AutoSyncService._setupTimedUpload() - Configurazione upload automatico");

        try
        {
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

            // MODIFICA: Usiamo sempre il setup forzato per garantire l'avvio
            this._setupForcedTimedUpload(); return;

            /* CODICE ORIGINALE COMMENTATO
            if (autoSyncEnabled) {
                // Ottieni l'intervallo e l'unità di tempo dalle impostazioni
                const interval = config.get<number>("autoSync.interval", 30);
                const unit = config.get<string>("autoSync.unit", "minutes");

                // Calcola l'intervallo in millisecondi
                let intervalMs = interval * 60 * 1000; // Default è minuti
                if (unit === "hours") {
                    intervalMs = interval * 60 * 60 * 1000;
                }

                console.log("[DEBUG] Intervallo configurato:", interval, unit, "(" + intervalMs + "ms)");

                // Usa un intervallo di controllo più breve per il debug
                const checkInterval = 10000; // 10 secondi per il debug
                console.log("[DEBUG] Intervallo di controllo timer impostato a:", checkInterval, "ms");

                // Imposta il timer per l'upload automatico
                this._timeoutId = setInterval(() => {
                    try {
                        console.log("[DEBUG] Controllo timer upload automatico");
                        // Verifica se è passato abbastanza tempo dall'ultimo upload manuale
                        const now = Date.now();
                        const timeSinceLastUpload = now - this._lastUploadTime;

                        console.log("[DEBUG] Tempo dall'ultimo upload:", timeSinceLastUpload, "ms, soglia:", intervalMs, "ms");

                        if (timeSinceLastUpload >= intervalMs) {
                            console.log("[DEBUG] Avvio upload automatico basato su timer");
                            this._eventEmitter.emit("upload_settings");
                            this._lastUploadTime = now;
                        }
                        else {
                            console.log("[DEBUG] Timer attivo ma non è ancora il momento di eseguire l'upload");
                            console.log("[DEBUG] Prossimo upload tra:", intervalMs - timeSinceLastUpload, "ms");
                        }
                    } catch (err) {
                        console.log("[DEBUG] Errore durante il controllo del timer:", err);
                        // Non interrompere il timer in caso di errore
                    }
                }, checkInterval); // Intervallo di controllo più breve per il debug

                console.log("[DEBUG] Timer upload automatico impostato, intervallo di controllo:", checkInterval, "ms");
            }
            else {
                console.log("[DEBUG] Upload automatico non abilitato, timer non configurato");
            }
            */
        }
        catch (err)
        {
            console.log("[DEBUG] Errore durante la configurazione del timer:", err);
            // In caso di errore, utilizziamo la versione forzata per garantire il funzionamento
            this._setupForcedTimedUpload();
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

    private async _shouldSynchronize(remoteStorage: IRemoteStorage): Promise<boolean>
    {
        console.log("[DEBUG] AutoSyncService._shouldSynchronize() - Verifica necessità di sincronizzazione");

        try
        {
            // Otteniamo l'istanza del tracker
            const syncTracker = SyncTracker.create();

            // Gets the last modified time (in milliseconds) of the local settings.
            console.log("[DEBUG] Recupero impostazioni locali");
            const local = await this._settingManager.getSettings();

            // Gets the last modified time (in milliseconds) of the remote storage.
            const remoteLastModified = new Date(remoteStorage.updated_at).getTime();
            console.log("[DEBUG] Data modifica remota:", new Date(remoteLastModified).toISOString());

            // Compares the local and remote settings.
            const localLastModified = this._settingManager.getLastModified(local);
            console.log("[DEBUG] Data modifica locale:", new Date(localLastModified).toISOString());
            console.log("[DEBUG] Data ultima sincronizzazione:", new Date(syncTracker.getLastSyncTimestamp()).toISOString());

            // Verifica del timestamp come prima
            const remoteIsNewer = isAfter(remoteLastModified, localLastModified);
            console.log("[DEBUG] Remoto più recente del locale (solo timestamp):", remoteIsNewer);

            if (!remoteIsNewer)
            {
                console.log("[DEBUG] Sincronizzazione non necessaria: le impostazioni locali sono più recenti");
                return false;
            }

            // Se il timestamp remoto è più recente, verifichiamo il contenuto effettivo
            console.log("[DEBUG] Verifica contenuto effettivo dei file");

            // Estrai i file in un formato compatibile con SyncTracker
            const fileContents: Record<string, string | Buffer> = {};
            if (remoteStorage.files)
            {
                for (const [filename, fileInfo] of Object.entries(remoteStorage.files))
                {
                    if (fileInfo.content)
                    {
                        fileContents[filename] = fileInfo.content;
                    }
                }
            }

            // Controlla se ci sono modifiche reali nel contenuto
            const needsDownload = syncTracker.shouldDownload(fileContents, remoteLastModified);

            if (needsDownload)
            {
                console.log("[DEBUG] Sincronizzazione necessaria: rilevate modifiche effettive nei file");

                // Se è necessario scaricare, aggiorniamo il tracker dopo il download
                // Questo verrà fatto nella funzione saveSettings
                return true;
            }

            // Se arriviamo qui, significa che i file remoti hanno un timestamp più recente
            // ma il contenuto è identico, quindi aggiorniamo il timestamp locale
            console.log("[DEBUG] Nessuna modifica effettiva rilevata, aggiornamento solo timestamp");
            syncTracker.updateSyncState(fileContents);

            console.log("[DEBUG] Sincronizzazione non necessaria: contenuto identico");
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

    private _clearTimers()
    {
        this._clearTimedUpload();
        this._stopWatchdog();
    }

    private _setupWatchdog()
    {
        this._startWatchdog();
    }
}
