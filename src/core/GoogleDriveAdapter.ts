// Adapter to maintain compatibility with the old Gist interface
// Delegates all operations to the GoogleDrive class
import { GoogleDrive } from "./GoogleDrive";
import type { ISetting, IRemoteStorage } from "../types";
/**
 * Adapter that maintains compatibility with the old Gist interface
 * Delegates all operations to the GoogleDrive class
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
     * @param _token Not used, maintained for compatibility
     * @param _proxy Not used, maintained for compatibility
     * @returns Instance of GoogleDriveAdapter that wraps GoogleDrive
     */
    public static create(_token?: string, _proxy?: string): GoogleDriveAdapter
    {
        // This class is now an adapter for GoogleDrive
        return new GoogleDriveAdapter();
    }

    /**
     * Gets settings from Google Drive.
     * @param _id Folder ID (not used)
     * @param showIndicator Indicates whether to show a loading indicator
     * @returns The remote settings
     */
    public async get(_id: string, showIndicator: boolean = false): Promise<IRemoteStorage>
    {
        return this._googleDrive.getFiles(showIndicator);
    }

    /**
     * Checks if settings exist in Google Drive.
     * @param id Folder ID (not used)
     * @returns Settings or false if not found
     */
    public async exists(id?: string): Promise<IRemoteStorage | false>
    {
        return this._googleDrive.exists(id);
    }

    /**
     * Finds and updates settings in Google Drive.
     * @param _id Folder ID (not used)
     * @param settings Settings to update
     * @param _isPublic Not used, maintained for compatibility
     * @param showIndicator Indicates whether to show a loading indicator
     * @returns Updated settings
     */
    public async findAndUpdate(_id: string, settings: ISetting[], _isPublic: boolean = false, showIndicator: boolean = false): Promise<IRemoteStorage>
    {
        // We use the uploadSettings method of GoogleDrive
        return this._googleDrive.uploadSettings(settings, showIndicator);
    }

    /**
     * Creates settings in Google Drive.
     * @param settings Settings to create
     * @param _isPublic Not used, maintained for compatibility
     * @param showIndicator Indicates whether to show a loading indicator
     * @returns Created settings
     */
    public async createSettings(settings: ISetting[], _isPublic: boolean = false, showIndicator: boolean = false): Promise<IRemoteStorage>
    {
        // We use the uploadSettings method of GoogleDrive
        return this._googleDrive.uploadSettings(settings, showIndicator);
    }
}
