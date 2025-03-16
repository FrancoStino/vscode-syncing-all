/**
 * VSCode message utils.
 */

import * as vscode from "vscode";

import { formatDistance } from "../utils/date";
import { locale, localize } from "../i18n";
import { restartWindow } from "../utils/vscodeAPI";
import type { Gist } from "./Gist";

/**
 * Represents the item of RemoteStorageListBox.
 */
interface IRemoteStorageListBoxItem extends vscode.QuickPickItem
{
    /**
     * The payload of the item.
     */
    data: string;
}

/**
 * Displays a message to the VSCode status bar.
 *
 * @param message The message to show.
 * @param hideAfterTimeout Timeout in milliseconds after which the message will be cleared.
 */
export function status(message: string, hideAfterTimeout?: number): void
{
    clearSpinner();

    if (hideAfterTimeout)
    {
        vscode.window.setStatusBarMessage("");
        vscode.window.setStatusBarMessage(message, hideAfterTimeout);
    }
    else
    {
        vscode.window.setStatusBarMessage(message);
    }
}

/**
 * Displays an `info` message to the VSCode status bar and auto-hide after `4000` milliseconds.
 *
 * @param message The message to show.
 */
export function statusInfo(message: string): void
{
    status(message, 4000);
}

/**
 * Displays an `error` message to the VSCode status bar and auto-hide after `8000` milliseconds.
 *
 * @param message The message to show.
 */
export function statusError(message: string): void
{
    status(message, 8000);
}

/**
 * Displays an `fatal` message to the VSCode status bar and auto-hide after `12000` milliseconds.
 *
 * @param message The message to show.
 */
export function statusFatal(message: string): void
{
    status(message, 12000);
}

/**
 * Shows the Personal Access Token input box.
 *
 * @param forUpload Whether to show messages for upload. Defaults to `true`.
 */
export async function showGitHubTokenInputBox(forUpload: boolean = true): Promise<string>
{
    const placeHolder = forUpload
        ? localize("toast.box.enter.github.token.upload")
        : localize("toast.box.enter.github.token.download");
    const options = {
        ignoreFocusOut: true,
        password: false,
        placeHolder,
        prompt: localize("toast.box.enter.github.token.description")
    };
    const value = await vscode.window.showInputBox(options);
    if (value === undefined)
    {
        // Cancelled.
        throw new Error(localize("error.abort.synchronization"));
    }
    else
    {
        const token = value.trim();
        if (!token && forUpload)
        {
            // Only throw when it's uploading.
            throw new Error(localize("error.no.github.token"));
        }
        return token;
    }
}

/**
 * Shows the Remote Storage ID input box.
 *
 * @param forUpload Whether to show messages for upload. Defaults to `true`.
 */
export async function showStorageInputBox(forUpload: boolean = true): Promise<string>
{
    const placeHolder = forUpload
        ? localize("toast.box.enter.gist.id.upload")
        : localize("toast.box.enter.gist.id.download");
    const value = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        password: false,
        placeHolder,
        prompt: localize("toast.box.enter.gist.id.description")
    });
    if (value === undefined)
    {
        // Cancelled.
        throw new Error(localize("error.abort.synchronization"));
    }
    else
    {
        const id = value.trim();
        if (!id && !forUpload)
        {
            // Only throw when it's downloading.
            throw new Error(localize("error.no.gist.id"));
        }
        return id;
    }
}

/**
 * Shows the remote storage list box.
 *
 * @param api Remote Storage utils.
 * @param forUpload Whether to show messages for upload. Defaults to `true`.
 */
export async function showRemoteStorageListBox(api: Gist, forUpload: boolean = true): Promise<string>
{
    showSpinner(localize("toast.settings.checking.remote.gists"));
    const storages = await api.getAll();
    clearSpinner("");

    const manualItem: IRemoteStorageListBoxItem = {
        data: "@@manual",
        description: "",
        label: localize("toast.box.enter.gist.id.manually")
    };

    let item: IRemoteStorageListBoxItem | undefined = manualItem;
    // Show quick pick dialog only if the storages list is not empty.
    if (storages.length > 0)
    {
        const items: IRemoteStorageListBoxItem[] = storages.map((storage) => ({
            data: storage.id,
            description: localize(
                "toast.box.gist.last.uploaded",
                formatDistance(new Date(storage.updated_at), new Date(), locale())
            ),
            label: `Storage ID: ${storage.id}`
        }));
        items.unshift(manualItem);
        item = await vscode.window.showQuickPick(items, {
            ignoreFocusOut: true,
            matchOnDescription: true,
            placeHolder: forUpload
                ? localize("toast.box.choose.gist.upload")
                : localize("toast.box.choose.gist.download")
        });
    }

    if (item === undefined)
    {
        // Cancelled.
        throw new Error(localize("error.abort.synchronization"));
    }
    else
    {
        const { data: id } = item;
        if (id === "@@manual")
        {
            return "";
        }
        else
        {
            return id;
        }
    }
}

/**
 * Shows a `Restart VSCode` prompt dialog.
 */
export function showRestartBox(): void
{
    const reloadButton = localize("toast.box.reload");
    const message = localize("toast.box.reload.message");
    vscode.window.showInformationMessage(message, reloadButton).then((selection) =>
    {
        if (selection === reloadButton)
        {
            restartWindow();
        }
    });
}

/**
 * @deprecated Use showRestartBox() instead
 * For backward compatibility.
 */
export function showReloadBox(): void
{
    showRestartBox();
}

/**
 * Shows a confirm prompt dialog.
 */
export function showConfirmBox(message: string, ...buttons: string[])
{
    return vscode.window.showInformationMessage(message, ...buttons);
}

let spinnerTimer: NodeJS.Timer | null;
const spinner = {
    frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    interval: 100
};

/**
 * Displays a message with spinner and progress.
 *
 * @param message Message to display after spinner.
 * @param progress Current progress.
 * @param total Total progress.
 */
export function showSpinner(message: string, progress?: number, total?: number): void
{
    clearSpinner();

    let text = "";
    if (progress != null && total != null)
    {
        text = `[${progress}/${total}]`;
    }

    if (message != null)
    {
        text = text ? `${text} ${message}` : `${message}`;
    }

    if (text)
    {
        text = ` ${text.trim()}`;
    }

    let step: number = 0;
    const frames: string[] = spinner.frames;
    const length: number = frames.length;
    spinnerTimer = setInterval(() =>
    {
        vscode.window.setStatusBarMessage(`${frames[step]}${text}`);
        step = (step + 1) % length;
    }, spinner.interval);
}

/**
 * Clears the spinner and displays the message, do nothing if currently there's no any spinner.
 *
 * @param message The message to show.
 */
export function clearSpinner(message?: string): void
{
    if (spinnerTimer)
    {
        clearInterval(spinnerTimer);
        spinnerTimer = null;

        if (message != null)
        {
            vscode.window.setStatusBarMessage(message);
        }
    }
}

/**
 * Interface for Google Drive folder item in the quick pick list
 */
interface IGoogleDriveFolderItem
{
    data: string;
    description: string;
    label: string;
}

/**
 * Shows the Google Drive folder list box for selection.
 *
 * @param googleDrive Google Drive client instance.
 * @param forUpload Whether to show messages for upload. Defaults to `true`.
 */
export async function showGoogleDriveFolderListBox(googleDrive: any, forUpload: boolean = true): Promise<string>
{
    showSpinner(localize("toast.settings.checking.google.folders"));

    try
    {
        const folders = await googleDrive.listFolders();
        clearSpinner("");

        // Option to create a new folder or enter manually
        const createNewItem: IGoogleDriveFolderItem = {
            data: "@@create_new",
            description: localize("toast.box.google.create.new.folder"),
            label: localize("toast.box.google.create.new.folder.label")
        };

        const manualItem: IGoogleDriveFolderItem = {
            data: "@@manual",
            description: "",
            label: localize("toast.box.enter.folder.id.manually")
        };

        let items: IGoogleDriveFolderItem[] = [];

        // Add existing folders
        if (folders.length > 0)
        {
            const folderItems = folders.map((folder: { id: string; name: string; date: string }) => ({
                data: folder.id,
                description: folder.date,
                label: `${folder.name} (${folder.id})`
            }));
            items = [...folderItems];
        }

        // Add create new option for upload
        if (forUpload)
        {
            items.unshift(createNewItem);
        }

        // Always add manual option
        items.unshift(manualItem);

        // Show quick pick dialog
        const item = await vscode.window.showQuickPick(items, {
            ignoreFocusOut: true,
            matchOnDescription: true,
            placeHolder: forUpload
                ? localize("toast.box.choose.google.folder.upload")
                : localize("toast.box.choose.google.folder.download")
        });

        if (item === undefined)
        {
            // Cancelled.
            throw new Error(localize("error.abort.synchronization"));
        }
        else
        {
            const { data: id } = item;

            if (id === "@@manual")
            {
                // Show input box for manual ID entry
                return await showGoogleDriveFolderInputBox(forUpload);
            }
            else if (id === "@@create_new")
            {
                // Create a new folder and return its ID
                showSpinner(localize("toast.google.folder.creating"));
                const folderId = await googleDrive.getOrCreateFolder(true);
                clearSpinner("");
                return folderId;
            }
            else
            {
                return id;
            }
        }
    }
    catch (error)
    {
        clearSpinner("");
        throw error;
    }
}

/**
 * Shows the Google Drive folder ID input box.
 *
 * @param forUpload Whether to show messages for upload. Defaults to `true`.
 */
export async function showGoogleDriveFolderInputBox(forUpload: boolean = true): Promise<string>
{
    const placeHolder = forUpload
        ? localize("toast.box.enter.google.folder.id.upload")
        : localize("toast.box.enter.google.folder.id.download");
    const value = await vscode.window.showInputBox({
        ignoreFocusOut: true,
        password: false,
        placeHolder,
        prompt: localize("toast.box.enter.google.folder.id.description")
    });

    if (value === undefined)
    {
        // Cancelled.
        throw new Error(localize("error.abort.synchronization"));
    }
    else
    {
        const id = value.trim();
        if (!id && !forUpload)
        {
            // Only throw when it's downloading.
            throw new Error(localize("error.no.folder.id"));
        }
        return id;
    }
}

/**
 * Interface for revision data returned from Google Drive
 */
interface IGoogleDriveRevision
{
    id: string;
    modifiedTime: string;
    originalFilename?: string;
}

/**
 * Interface for revision item in the quick pick list
 */
interface IRevisionItem extends vscode.QuickPickItem
{
    fileId: string;
    revisionId: string;
    modifiedTime: string;
}

/**
 * Interface for file item in the quick pick list
 */
interface IFileItem extends vscode.QuickPickItem
{
    fileId: string;
    filename: string;
}

/**
 * Converts a localized date string (DD/MM/YYYY format) to a proper Date object
 * @param dateStr Date string in localized format
 * @returns Valid Date object
 */
function parseLocalizedDate(dateStr: string): Date
{
    // Verifica se la data è nel formato italiano (GG/MM/AAAA, HH:MM:SS)
    const italianDateRegex = /(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/;
    const match = dateStr.match(italianDateRegex);

    if (match)
    {
        // Estrai i componenti della data dal match
        const day = parseInt(match[1], 10);
        const month = parseInt(match[2], 10) - 1; // Mesi in JS sono 0-indexed
        const year = parseInt(match[3], 10);
        const hour = parseInt(match[4], 10);
        const minute = parseInt(match[5], 10);
        const second = parseInt(match[6], 10);

        // Crea una data valida usando i componenti numerici
        const date = new Date(year, month, day, hour, minute, second);
        console.log(`Data convertita da ${dateStr} a ${date.toISOString()}`);
        return date;
    }

    // Se non è nel formato italiano, prova il parser standard di JS
    const date = new Date(dateStr);

    // Verifica che la data sia valida
    if (isNaN(date.getTime()))
    {
        console.error(`Impossibile analizzare la data: ${dateStr}`);
        // Ritorna la data corrente come fallback
        return new Date();
    }

    return date;
}

/**
 * Shows a quickpick with all files in Google Drive for selecting which file to restore
 *
 * @param googleDrive Google Drive client instance
 * @returns Promise with the selected file data
 */
export async function showFileSelectQuickPick(googleDrive: any): Promise<{ fileId: string; filename: string } | undefined>
{
    showSpinner(localize("toast.settings.checking.files"));

    try
    {
        const fileMap = await googleDrive.getAllFileIds();
        clearSpinner("");

        if (fileMap.size === 0)
        {
            await vscode.window.showInformationMessage(localize("toast.files.none"));
            return undefined;
        }

        const items: IFileItem[] = Array.from(fileMap.entries()).map(([filename, fileId]) => ({
            label: filename,
            description: fileId,
            fileId,
            filename
        }));

        const selectedFile = await vscode.window.showQuickPick(items, {
            ignoreFocusOut: true,
            placeHolder: localize("toast.box.choose.file.restore")
        });

        if (!selectedFile)
        {
            return undefined;
        }

        return {
            fileId: selectedFile.fileId,
            filename: selectedFile.filename
        };
    }
    catch (error: any)
    {
        clearSpinner("");
        console.error("Error listing files for quickpick:", error);
        vscode.window.showErrorMessage(localize("toast.files.error", error.message));
        return undefined;
    }
}

/**
 * Shows a quickpick with all revisions of a file in Google Drive
 *
 * @param googleDrive Google Drive client instance
 * @param fileId ID of the file to get revisions for
 * @param filename Name of the file
 * @returns Promise with the selected revision data
 */
export async function showRevisionsQuickPick(googleDrive: any, fileId: string, filename: string): Promise<{ fileId: string; revisionId: string; filename: string } | undefined>
{
    showSpinner(localize("toast.settings.checking.revisions"));

    try
    {
        const revisions = await googleDrive.getFileRevisions(fileId) as IGoogleDriveRevision[];
        clearSpinner("");

        if (revisions.length === 0)
        {
            await vscode.window.showInformationMessage(localize("toast.revisions.none"));
            return undefined;
        }

        // Debug: verifica i dati delle revisioni
        console.log("Revisioni ricevute:", revisions);

        const items: IRevisionItem[] = revisions.map((revision: IGoogleDriveRevision) =>
        {
            // Gestione più sicura delle date
            let dateLabel = "Data non disponibile";
            try
            {
                // Controllo che modifiedTime esista e sia una stringa valida
                if (revision.modifiedTime)
                {
                    // Usa il parser personalizzato per gestire il formato italiano
                    const date = parseLocalizedDate(revision.modifiedTime);
                    dateLabel = date.toLocaleString();
                }
            }
            catch (error)
            {
                console.error("Errore nella conversione della data:", error);
            }

            return {
                label: dateLabel,
                description: revision.id,
                fileId,
                revisionId: revision.id,
                modifiedTime: revision.modifiedTime
            };
        });

        const selectedRevision = await vscode.window.showQuickPick(items, {
            ignoreFocusOut: true,
            placeHolder: localize("toast.box.choose.revision", filename)
        });

        if (!selectedRevision)
        {
            return undefined;
        }

        return {
            fileId,
            revisionId: selectedRevision.revisionId,
            filename
        };
    }
    catch (error: any)
    {
        clearSpinner("");
        console.error("Error listing revisions for quickpick:", error);
        vscode.window.showErrorMessage(localize("toast.revisions.error", error.message));
        return undefined;
    }
}

/**
 * Shows a quickpick with all dates available for all files
 * Groups revisions by date for global restore
 *
 * @param googleDrive Google Drive client instance
 * @returns Promise with the selected date
 */
export async function showDatesQuickPick(googleDrive: any): Promise<string | undefined>
{
    showSpinner(localize("toast.settings.checking.dates"));

    try
    {
        // Get all files
        const fileMap = await googleDrive.getAllFileIds();

        if (fileMap.size === 0)
        {
            clearSpinner("");
            await vscode.window.showInformationMessage(localize("toast.files.none"));
            return undefined;
        }

        // Get all revisions for all files
        const allDates = new Set<string>();

        for (const [_, fileId] of fileMap.entries())
        {
            try
            {
                const revisions = await googleDrive.getFileRevisions(fileId) as IGoogleDriveRevision[];
                console.log(`Revisioni per file ${fileId}:`, revisions);

                for (const revision of revisions)
                {
                    try
                    {
                        // Verifica che modifiedTime esista e sia una stringa valida
                        if (revision.modifiedTime)
                        {
                            // Usa il parser personalizzato per gestire il formato italiano
                            const revDate = parseLocalizedDate(revision.modifiedTime);

                            // Usa toLocaleDateString per estrarre solo la data (senza l'ora)
                            const dateOnly = revDate.toLocaleDateString();
                            allDates.add(dateOnly);
                            console.log(`Data aggiunta: ${dateOnly} da ${revision.modifiedTime}`);
                        }
                    }
                    catch (dateError)
                    {
                        console.error("Errore nell'elaborazione della data:", dateError);
                    }
                }
            }
            catch (fileError)
            {
                console.error(`Errore nel recupero delle revisioni per il file ${fileId}:`, fileError);
            }
        }

        clearSpinner("");

        if (allDates.size === 0)
        {
            await vscode.window.showInformationMessage(localize("toast.dates.none"));
            return undefined;
        }

        // Sort dates in descending order (newest first)
        const sortedDates = Array.from(allDates).sort((a, b) =>
        {
            try
            {
                const dateA = parseLocalizedDate(a);
                const dateB = parseLocalizedDate(b);
                return dateB.getTime() - dateA.getTime();
            }
            catch (error)
            {
                console.error("Errore durante l'ordinamento delle date:", error);
                return 0;
            }
        });

        console.log("Date ordinate:", sortedDates);

        const items = sortedDates.map(date => ({
            label: date,
            description: ""
        }));

        const selectedDate = await vscode.window.showQuickPick(items, {
            ignoreFocusOut: true,
            placeHolder: localize("toast.box.choose.date.restore")
        });

        if (!selectedDate)
        {
            return undefined;
        }

        return selectedDate.label;
    }
    catch (error: any)
    {
        clearSpinner("");
        console.error("Error listing dates for quickpick:", error);
        vscode.window.showErrorMessage(localize("toast.dates.error", error.message));
        return undefined;
    }
}
