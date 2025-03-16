// Adapter per mantenere la compatibilità con la vecchia interfaccia Gist
// Delega tutte le operazioni alla classe GoogleDrive

import { GoogleDrive } from "./GoogleDrive";
import type { ISetting, IRemoteStorage } from "../types";

/**
 * Adapter che mantiene la compatibilità con la vecchia interfaccia Gist
 * Delega tutte le operazioni alla classe GoogleDrive
 */
export class GoogleDriveAdapter
{
    private _googleDrive: GoogleDrive;

    constructor()
    {
        this._googleDrive = GoogleDrive.create();
    }

    /**
     * Creates a GoogleDrive instance
     * @param _token Non utilizzato, mantenuto per compatibilità
     * @param _proxy Non utilizzato, mantenuto per compatibilità
     * @returns Istanza di GoogleDriveAdapter che wrappa GoogleDrive
     */
    public static create(_token?: string, _proxy?: string): GoogleDriveAdapter
    {
        // Questa classe ora è un adapter per GoogleDrive
        return new GoogleDriveAdapter();
    }

    /**
     * Gets settings from Google Drive.
     * @param _id ID cartella (non utilizzato)
     * @param showIndicator Indica se mostrare un indicatore di caricamento
     * @returns Le impostazioni remote
     */
    public async get(_id: string, showIndicator: boolean = false): Promise<IRemoteStorage>
    {
        return this._googleDrive.getFiles(showIndicator);
    }

    /**
     * Checks if settings exist in Google Drive.
     * @param id ID cartella (non utilizzato)
     * @returns Impostazioni o false se non trovate
     */
    public async exists(id?: string): Promise<IRemoteStorage | false>
    {
        return this._googleDrive.exists(id);
    }

    /**
     * Finds and updates settings in Google Drive.
     * @param _id ID cartella (non utilizzato)
     * @param settings Impostazioni da aggiornare
     * @param _isPublic Non utilizzato, mantenuto per compatibilità
     * @param showIndicator Indica se mostrare un indicatore di caricamento
     * @returns Impostazioni aggiornate
     */
    public async findAndUpdate(_id: string, settings: ISetting[], _isPublic: boolean = false, showIndicator: boolean = false): Promise<IRemoteStorage>
    {
        // Utilizziamo il metodo uploadSettings di GoogleDrive
        return this._googleDrive.uploadSettings(settings, showIndicator);
    }

    /**
     * Creates settings in Google Drive.
     * @param settings Impostazioni da creare
     * @param _isPublic Non utilizzato, mantenuto per compatibilità
     * @param showIndicator Indica se mostrare un indicatore di caricamento
     * @returns Impostazioni create
     */
    public async createSettings(settings: ISetting[], _isPublic: boolean = false, showIndicator: boolean = false): Promise<IRemoteStorage>
    {
        // Utilizziamo il metodo uploadSettings di GoogleDrive
        return this._googleDrive.uploadSettings(settings, showIndicator);
    }
}
