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
                    if (!syncingSettings.google_client_id || !syncingSettings.google_client_secret || !syncingSettings.google_refresh_token)
                    {
                        // Show error for missing Google Drive credentials
                        throw new Error(localize("error.missing.google.credentials"));
                    }

                    const googleDrive = _syncing.getGoogleDriveClient();

                    // Pass the filtered settings directly to uploadSettings
                    const storage = await googleDrive.uploadSettings(filteredSettings, true);

                    // Salviamo solo l'ID della cartella nelle impostazioni di Syncing
                    if (syncingSettings.id !== storage.id)
                    {
                        syncingSettings.id = storage.id;
                        await _syncing.saveSettings(syncingSettings);
                    }

                    Toast.statusInfo(localize("toast.settings.uploaded"));
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

                // Show starting download toast
                Toast.statusInfo(localize("toast.settings.downloading"));

                const syncingSettings = _syncing.loadSettings();

                // Check storage provider and call appropriate download method
                if (syncingSettings.storage_provider === StorageProvider.GoogleDrive)
                {
                    // Use Google Drive
                    if (!syncingSettings.id)
                    {
                        throw new Error(localize("error.no.storage.id"));
                    }

                    if (!syncingSettings.google_client_id || !syncingSettings.google_client_secret || !syncingSettings.google_refresh_token)
                    {
                        throw new Error(localize("error.missing.google.credentials"));
                    }

                    const googleDrive = _syncing.getGoogleDriveClient();
                    const remoteSettings = await googleDrive.getFiles(true);

                    // 2. Download settings.
                    const syncedItems = await _vscodeSetting.saveSettings(remoteSettings, true);

                    Toast.statusInfo(_getSyncingCompleteMessage(syncedItems));

                    // 3. Restart window (after "synced").
                    await _showRestartPrompt();
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
