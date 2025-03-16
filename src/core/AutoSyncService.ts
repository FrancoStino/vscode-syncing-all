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
        console.log("[DEBUG] AutoSyncService constructor - Service initialization");
        this._settingManager = VSCodeSetting.create();
        this._watcher = new SettingsWatcherService();
        this._eventEmitter = new EventEmitter();
        this._watcher.on(WatcherEvent.ALL, () => { this._handleWatcherEvent(); });

        // Force immediate activation for debugging
        setTimeout(() =>
        {
            console.log("[DEBUG] Initial check of automatic upload configuration");
            this._setupTimedUpload();

            // Also check if it's active after setup
            setTimeout(() =>
            {
                console.log("[DEBUG] Auto-sync status after initialization:");
                console.log("[DEBUG] - running:", this._running);
                console.log("[DEBUG] - timerActive:", this._timeoutId !== null);
                console.log("[DEBUG] - autoSyncEnabled:", vscode.workspace.getConfiguration("syncing").get<boolean>("autoSync.enabled", false));
            }, 2000);
        }, 5000);

        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e =>
        {
            if (e.affectsConfiguration("syncing.autoSync"))
            {
                console.log("[DEBUG] Detected autoSync configuration change");
                this._setupTimedUpload();

                // Check if it's active after setup
                setTimeout(() =>
                {
                    const autoSyncEnabled = vscode.workspace.getConfiguration("syncing").get<boolean>("autoSync.enabled", false);
                    console.log("[DEBUG] Status after configuration change:");
                    console.log("[DEBUG] - autoSyncEnabled:", autoSyncEnabled);
                    console.log("[DEBUG] - running:", this._running);
                    console.log("[DEBUG] - timerActive:", this._timeoutId !== null);
                }, 1000);
            }
        });

        // Start the watchdog immediately for continuous monitoring
        this._startWatchdog();
    }

    /**
     * Creates an instance of the class `AutoSyncService`.
     */
    public static create(): AutoSyncService
    {
        console.log("[DEBUG] AutoSyncService.create() - Creating singleton instance");
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
        console.log("[DEBUG] AutoSyncService.on() - Registering listener for event:", event);
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
        console.log("[DEBUG] AutoSyncService.start() - Starting auto-sync service");
        this._running = true;

        // Clean existing timers before restarting
        this._clearTimers();

        // Reset _lastUploadTime to a value that will allow upload when needed
        // but won't force an immediate upload on start
        this._lastUploadTime = Date.now();

        // Activate the watchdog to monitor that the service remains active
        this._setupWatchdog();

        // Configure the timer for periodic uploads
        this._setupForcedTimedUpload();

        // On service start, only check if there are newer remote settings
        setTimeout(async () =>
        {
            if (this._running)
            {
                try
                {
                    console.log("[DEBUG] Initial check for synchronization operations");

                    // Check if there are newer remote settings to download
                    console.log("[DEBUG] Checking for newer remote settings");
                    this._checkForNewerRemoteSettings();

                    // DO NOT perform automatic upload on start, only check for downloads
                    // which will already include date checking
                }
                catch (err)
                {
                    console.log("[DEBUG] Error during initial check:", err);
                    // Don't interrupt the service in case of error
                }
            }
        }, 3000); // 3-second delay to ensure everything is ready
    }


    /**
     * Pause auto-sync service.
     */
    public pause()
    {
        console.log("[DEBUG] AutoSyncService.pause() - Pausing auto-sync service");
        this._running = false;
        this._watcher.pause();
        this._clearTimedUpload();
    }

    /**
     * Resume auto-sync service.
     */
    public resume()
    {
        console.log("[DEBUG] AutoSyncService.resume() - Resuming auto-sync service");
        this._running = true;
        this._watcher.resume();
        this._setupTimedUpload();
    }

    /**
     * Stop auto-sync service.
     */
    public stop()
    {
        console.log("[DEBUG] AutoSyncService.stop() - Stopping auto-sync service");
        this._running = false;
        this._watcher.stop();
        this._clearTimedUpload();

        // Don't stop the watchdog - it will continue monitoring
    }

    /**
     * Synchronize settings.
     */
    public async synchronize(syncingSettings: ISyncingSettings)
    {
        console.log("[DEBUG] AutoSyncService.synchronize() - Starting automatic synchronization");

        try
        {
            Toast.showSpinner(localize("toast.settings.autoSync.checkingSettings"));

            // Always use Google Drive
            console.log("[DEBUG] Synchronizing with Google Drive");

            const googleDriveClient = GoogleDrive.create();

            // Check if we have a refresh token, if not, we can't synchronize
            if (!syncingSettings.google_refresh_token)
            {
                console.log("[DEBUG] Error: Missing Google Drive refresh token");
                throw new Error(localize("error.missing.google.credentials"));
            }

            // If there's no folder ID, we can't synchronize
            if (!syncingSettings.id)
            {
                console.log("[DEBUG] Error: Missing Google Drive folder ID");
                throw new Error(localize("error.no.folder.id"));
            }

            // 1. Check remote settings.
            console.log("[DEBUG] Checking remote settings on Google Drive");
            const remoteDrive = await googleDriveClient.getFiles();

            // 2. Check if need synchronize.
            console.log("[DEBUG] Checking if synchronization is needed");
            const shouldSync = await this._shouldSynchronize(remoteDrive);

            console.log("[DEBUG] Synchronization needed:", shouldSync);

            if (shouldSync)
            {
                // 3. Synchronize settings.
                console.log("[DEBUG] Starting to save remote settings");
                await this._settingManager.saveSettings(remoteDrive);
                console.log("[DEBUG] Settings save completed");
            }
            console.log("[DEBUG] Synchronization completed without changes");
            Toast.statusInfo(localize("toast.settings.autoSync.nothingChanged"));
        }
        catch (err: any)
        {
            console.log("[DEBUG] Error during synchronization:", err.message);
            throw err;
        }
        return false;
    }

    /**
    * Update the timestamp of the last upload
    * Call this when the user performs a manual upload
    */
    public updateLastUploadTime()
    {
        const previousTime = this._lastUploadTime;
        this._lastUploadTime = Date.now();

        console.log("[DEBUG] AutoSyncService.updateLastUploadTime() - Updating last upload timestamp:",
            new Date(previousTime).toISOString(), "->", new Date(this._lastUploadTime).toISOString());
    }


    /**
     * Returns the current status of automatic synchronization for debugging
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
     * Check if there are newer remote settings and start download
     */
    private _checkForNewerRemoteSettings()
    {
        console.log("[DEBUG] AutoSyncService._checkForNewerRemoteSettings() - Checking remote settings");
        try
        {
            // Emit the download event that already contains the date checking logic
            console.log("[DEBUG] Emitting download_settings event to check remote settings");
            this._eventEmitter.emit("download_settings");
        }
        catch (err)
        {
            console.log("[DEBUG] Error while checking remote settings:", err);
        }
    }


    /**
     * Start the watchdog that continuously checks the service status
     * and restarts it if necessary
     */
    private _startWatchdog()
    {
        console.log("[DEBUG] AutoSyncService._startWatchdog() - Starting watchdog for continuous monitoring");

        // Stop any existing watchdog
        this._stopWatchdog();

        // Start a new watchdog
        this._watchdogId = setInterval(() =>
        {
            try
            {
                const autoSyncEnabled = vscode.workspace.getConfiguration("syncing").get<boolean>("autoSync.enabled", false);
                const settings = vscode.workspace.getConfiguration("syncing").get("settings", {}) as any;
                const settingsAutoSync = settings && settings.auto_sync;

                console.log("[DEBUG] Watchdog - Checking auto-sync status:");
                console.log("[DEBUG] - autoSync.enabled:", autoSyncEnabled);
                console.log("[DEBUG] - settings.auto_sync:", settingsAutoSync);
                console.log("[DEBUG] - running:", this._running);
                console.log("[DEBUG] - timerActive:", this._timeoutId !== null);

                // If autoSync should be active but isn't
                if ((autoSyncEnabled || settingsAutoSync) && (!this._running || !this._timeoutId))
                {
                    console.log("[DEBUG] Watchdog - Detected unexpected auto-sync stop, restarting...");

                    // Force stop to clean the state
                    this._running = false;
                    this._clearTimedUpload();

                    // Restart the service only if auto-sync is enabled
                    if (this._autoRestartEnabled && (autoSyncEnabled || settingsAutoSync))
                    {
                        console.log("[DEBUG] Watchdog - Automatic service restart");
                        this._running = true;
                        this._watcher.start();
                        this._setupTimedUpload();

                        // After restart, check if it actually started
                        setTimeout(() =>
                        {
                            if (!this._timeoutId)
                            {
                                console.log("[DEBUG] Watchdog - Restart failed, new attempt in 60 seconds");
                            }
                            else
                            {
                                console.log("[DEBUG] Watchdog - Restart successful");
                            }
                        }, 1000);
                    }
                }
                else if (!autoSyncEnabled && !settingsAutoSync && (this._running || this._timeoutId))
                {
                    // If auto-sync shouldn't be active but is
                    console.log("[DEBUG] Watchdog - Auto-sync should be off but is running, stopping...");
                    this._running = false;
                    this._clearTimedUpload();
                }
            }
            catch (err)
            {
                console.log("[DEBUG] Error in watchdog:", err);
                // Don't interrupt the watchdog in case of error
            }
        }, 15000); // Check every 15 seconds
    }

    /**
     * Stop the watchdog
     */
    private _stopWatchdog()
    {
        if (this._watchdogId)
        {
            clearInterval(this._watchdogId);
            this._watchdogId = null;
            console.log("[DEBUG] AutoSyncService._stopWatchdog() - Watchdog stopped");
        }
    }

    /**
     * Set up the upload timer forcibly ignoring all conditions
     */
    private _setupForcedTimedUpload()
    {
        console.log("[DEBUG] AutoSyncService._setupForcedTimedUpload() - Forced upload configuration");

        // Cancel any existing timers
        this._clearTimedUpload();

        // Get the interval configured in settings
        const config = vscode.workspace.getConfiguration("syncing");
        const interval = config.get<number>("autoSync.interval", 30);
        const unit = config.get<string>("autoSync.unit", "minutes");

        // Calculate interval in milliseconds for comparison
        let intervalMs = interval * 60 * 1000; // Default is minutes
        if (unit === "hours")
        {
            intervalMs = interval * 60 * 60 * 1000;
        }

        // Calculate a check interval proportional to the configured interval
        // The check interval will be about 1/10 of the configured interval
        // With a minimum of 5 seconds and a maximum of 2 minutes
        let checkInterval = Math.floor(intervalMs / 10);

        // Set reasonable limits
        const MIN_CHECK_INTERVAL = 5000; // Minimum 5 seconds
        const MAX_CHECK_INTERVAL = 120000; // Maximum 2 minutes

        if (checkInterval < MIN_CHECK_INTERVAL)
        {
            checkInterval = MIN_CHECK_INTERVAL;
        }
        else if (checkInterval > MAX_CHECK_INTERVAL)
        {
            checkInterval = MAX_CHECK_INTERVAL;
        }

        console.log(`[DEBUG] Timer configuration: configured interval ${interval} ${unit}, check interval: ${checkInterval / 1000} seconds`);

        // Set the timer for automatic upload
        this._timeoutId = setInterval(() =>
        {
            try
            {
                console.log("[DEBUG] Checking automatic upload timer");

                // Check if enough time has passed since the last manual upload
                const now = Date.now();
                const timeSinceLastUpload = now - this._lastUploadTime;

                // Calculate remaining time in minutes and seconds for logs
                const remainingMs = intervalMs - timeSinceLastUpload;
                const remainingMinutes = Math.floor(remainingMs / 60000);
                const remainingSeconds = Math.floor((remainingMs % 60000) / 1000);

                console.log("[DEBUG] -------------------------------------------------");
                console.log(`[DEBUG] CONFIGURED INTERVAL: ${interval} ${unit}`);
                console.log(`[DEBUG] Check interval: ${checkInterval / 1000} seconds`);
                console.log(`[DEBUG] Time elapsed since last upload: ${Math.floor(timeSinceLastUpload / 60000)} min ${Math.floor((timeSinceLastUpload % 60000) / 1000)} sec`);

                if (timeSinceLastUpload >= intervalMs)
                {
                    console.log(`[DEBUG] EXECUTING UPLOAD: interval of ${interval} ${unit} reached!`);
                    this._eventEmitter.emit("upload_settings");
                    this._lastUploadTime = now;
                }
                else
                {
                    console.log(`[DEBUG] NEXT UPLOAD IN: ${remainingMinutes} min and ${remainingSeconds} sec (based on setting ${interval} ${unit})`);
                }
                console.log("[DEBUG] -------------------------------------------------");
            }
            catch (err)
            {
                console.log("[DEBUG] Error during timer check:", err);
                // Don't interrupt the timer in case of error
            }
        }, checkInterval);

        console.log(`[DEBUG] Automatic upload timer set with check interval: ${checkInterval / 1000} seconds`);
    }

    /**
     * Configure time-based automatic upload
     */
    private _setupTimedUpload()
    {
        console.log("[DEBUG] AutoSyncService._setupTimedUpload() - Configuring automatic upload");

        try
        {
            // Cancel any existing timers
            this._clearTimedUpload();

            // Check if automatic upload is enabled
            const config = vscode.workspace.getConfiguration("syncing");
            const autoSyncEnabled = config.get<boolean>("autoSync.enabled", false);

            console.log("[DEBUG] Automatic upload enabled:", autoSyncEnabled);
            console.log("[DEBUG] Service running:", this._running);

            // Set running flag to true if autoSync is enabled
            if (autoSyncEnabled && !this._running)
            {
                console.log("[DEBUG] Setting running=true because autoSync is enabled");
                this._running = true;
            }

            // Check if auto-sync is enabled before proceeding
            if (autoSyncEnabled)
            {
                // Use forced setup to ensure startup
                this._setupForcedTimedUpload();
            }
            else
            {
                console.log("[DEBUG] Auto-sync not enabled in settings, skipping timer setup");
                // Make sure we're not running
                this._running = false;
            }
            return;

            /* ORIGINAL CODE COMMENTED OUT
            if (autoSyncEnabled) {
                // Get interval and time unit from settings
                const interval = config.get<number>("autoSync.interval", 30);
                const unit = config.get<string>("autoSync.unit", "minutes");

                // Calculate interval in milliseconds
                let intervalMs = interval * 60 * 1000; // Default is minutes
                if (unit === "hours") {
                    intervalMs = interval * 60 * 60 * 1000;
                }

                console.log("[DEBUG] Configured interval:", interval, unit, "(" + intervalMs + "ms)");

                // Use a shorter check interval for debugging
                const checkInterval = 10000; // 10 seconds for debugging
                console.log("[DEBUG] Timer check interval set to:", checkInterval, "ms");

                // Set the timer for automatic upload
                this._timeoutId = setInterval(() => {
                    try {
                        console.log("[DEBUG] Checking automatic upload timer");
                        // Check if enough time has passed since the last manual upload
                        const now = Date.now();
                        const timeSinceLastUpload = now - this._lastUploadTime;

                        console.log("[DEBUG] Time since last upload:", timeSinceLastUpload, "ms, threshold:", intervalMs, "ms");

                        if (timeSinceLastUpload >= intervalMs) {
                            console.log("[DEBUG] Starting timer-based automatic upload");
                            this._eventEmitter.emit("upload_settings");
                            this._lastUploadTime = now;
                        }
                        else {
                            console.log("[DEBUG] Timer active but it's not time to upload yet");
                            console.log("[DEBUG] Next upload in:", intervalMs - timeSinceLastUpload, "ms");
                        }
                    } catch (err) {
                        console.log("[DEBUG] Error during timer check:", err);
                        // Don't interrupt the timer in case of error
                    }
                }, checkInterval); // Shorter check interval for debugging

                console.log("[DEBUG] Automatic upload timer set, check interval:", checkInterval, "ms");
            }
            else {
                console.log("[DEBUG] Automatic upload not enabled, timer not configured");
            }
            */
        }
        catch (err)
        {
            console.log("[DEBUG] Error during timer configuration:", err);
            // In case of error, use the forced version to ensure functionality
            this._setupForcedTimedUpload();
        }
    }

    /**
     * Cancel the timer for automatic upload
     */
    private _clearTimedUpload()
    {
        console.log("[DEBUG] AutoSyncService._clearTimedUpload() - Cancelling automatic upload timer");
        if (this._timeoutId)
        {
            clearInterval(this._timeoutId);
            this._timeoutId = null;
            console.log("[DEBUG] Automatic upload timer cancelled");
        }
    }

    private async _shouldSynchronize(remoteStorage: IRemoteStorage): Promise<boolean>
    {
        console.log("[DEBUG] AutoSyncService._shouldSynchronize() - Checking if synchronization is necessary");

        try
        {
            // Get the tracker instance
            const syncTracker = SyncTracker.create();

            // Gets the last modified time (in milliseconds) of the local settings.
            console.log("[DEBUG] Retrieving local settings");
            const local = await this._settingManager.getSettings();

            // Gets the last modified time (in milliseconds) of the remote storage.
            const remoteLastModified = new Date(remoteStorage.updated_at).getTime();
            console.log("[DEBUG] Remote modification date:", new Date(remoteLastModified).toISOString());

            // Compares the local and remote settings.
            const localLastModified = this._settingManager.getLastModified(local);
            console.log("[DEBUG] Local modification date:", new Date(localLastModified).toISOString());
            console.log("[DEBUG] Last synchronization date:", new Date(syncTracker.getLastSyncTimestamp()).toISOString());

            // Timestamp verification as before
            const remoteIsNewer = isAfter(remoteLastModified, localLastModified);
            console.log("[DEBUG] Remote is newer than local (timestamp only):", remoteIsNewer);

            if (!remoteIsNewer)
            {
                console.log("[DEBUG] Synchronization not necessary: local settings are more recent");
                return false;
            }

            // If the remote timestamp is newer, check the actual content
            console.log("[DEBUG] Checking actual file contents");

            // Extract files in a format compatible with SyncTracker
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

            // Check if there are actual changes in content
            const needsDownload = syncTracker.shouldDownload(fileContents, remoteLastModified);

            if (needsDownload)
            {
                console.log("[DEBUG] Synchronization necessary: detected actual changes in files");

                // If download is needed, we'll update the tracker after download
                // This will be done in the saveSettings function
                return true;
            }

            // If we get here, it means the remote files have a newer timestamp
            // but the content is identical, so we update the local timestamp
            console.log("[DEBUG] No actual changes detected, updating timestamp only");
            syncTracker.updateSyncState(fileContents);

            console.log("[DEBUG] Synchronization not necessary: identical content");
            return false;
        }
        catch (err: any)
        {
            console.log("[DEBUG] Error during synchronization check:", err.message);
            return false;
        }
    }

    private _handleWatcherEvent()
    {
        console.log("[DEBUG] AutoSyncService._handleWatcherEvent() - Watcher event detected");
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
