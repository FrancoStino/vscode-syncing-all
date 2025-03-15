import { EventEmitter } from "events";

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

    private constructor()
    {
        this._gistSetting = VSCodeSetting.create();
        this._watcher = new SettingsWatcherService();
        this._eventEmitter = new EventEmitter();
        this._watcher.on(WatcherEvent.ALL, () => { this._handleWatcherEvent(); });
    }

    /**
     * Creates an instance of the class `AutoSyncService`.
     */
    public static create(): AutoSyncService
    {
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
        this._running = true;
        this._watcher.start();
    }

    /**
     * Pause auto-sync service.
     */
    public pause()
    {
        this._running = false;
        this._watcher.pause();
    }

    /**
     * Resume auto-sync service.
     */
    public resume()
    {
        this._running = true;
        this._watcher.resume();
    }

    /**
     * Stop auto-sync service.
     */
    public stop()
    {
        this._running = false;
        this._watcher.stop();
    }

    /**
     * Synchronize settings.
     */
    public async synchronize(syncingSettings: ISyncingSettings)
    {
        try
        {
            Toast.showSpinner(localize("toast.settings.autoSync.checkingSettings"));

            // Check if storage provider has valid settings
            if (syncingSettings.storage_provider === StorageProvider.GoogleDrive)
            {
                if (!syncingSettings.google_client_id || !syncingSettings.google_client_secret || !syncingSettings.google_refresh_token)
                {
                    throw new Error(localize("error.missing.google.credentials"));
                }

                const drive = GoogleDrive.create(
                    syncingSettings.google_client_id,
                    syncingSettings.google_client_secret,
                    syncingSettings.google_refresh_token,
                    syncingSettings.id
                );

                // 1. Check remote settings.
                const remoteGist = await drive.getFiles();

                // 2. Check if need synchronize.
                const shouldSync = await this._shouldSynchronize(remoteGist);
                if (shouldSync)
                {
                    // 3. Synchronize settings.
                    await this._gistSetting.saveSettings(remoteGist);
                }
            }
            else
            {
                // GitHub Gist
                if (!syncingSettings.token || !syncingSettings.id)
                {
                    throw new Error(localize("error.empty.token.or.id"));
                }

                const api = Gist.create(syncingSettings.token);

                // 1. Check remote settings.
                const remoteGist = await api.get(syncingSettings.id);

                // 2. Check if need synchronize.
                const shouldSync = await this._shouldSynchronize(remoteGist);
                if (shouldSync)
                {
                    // 3. Synchronize settings.
                    await this._gistSetting.saveSettings(remoteGist);
                }
            }
            Toast.statusInfo(localize("toast.settings.autoSync.nothingChanged"));
        }
        catch (err: any)
        {
            throw err;
        }
        return false;
    }

    private async _shouldSynchronize(gist: IRemoteStorage): Promise<boolean>
    {
        try
        {
            // Gets the last modified time (in milliseconds) of the local settings.
            const local = await this._gistSetting.getSettings();

            // Gets the last modified time (in milliseconds) of the remote gist.
            const remoteLastModified = new Date(gist.updated_at).getTime();

            // Compares the local and remote settings.
            const localLastModified = this._gistSetting.getLastModified(local);
            if (isAfter(remoteLastModified, localLastModified))
            {
                return true;
            }
            return false;
        }
        catch (err: any)
        {
            return false;
        }
    }

    private _handleWatcherEvent()
    {
        // Emit event to trigger upload
        this._eventEmitter.emit("upload_settings");
    }
}
