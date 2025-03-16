import * as fs from "fs-extra";
import * as path from "path";
import * as crypto from "crypto";
import { Environment } from "./Environment";

interface ISyncState
{
    lastSyncTimestamp: number;
    fileHashes: Record<string, string>;
}

/**
 * Class that manages intelligent synchronization tracking
 */
export class SyncTracker
{
    private static _instance: SyncTracker;
    private _env: Environment;
    private _timestampFilePath: string;
    private _syncState: ISyncState;
    private _remoteFilename: string = "sync-tracker.json";

    private constructor()
    {
        this._env = Environment.create();
        // Create the file in the same directory as user settings
        this._timestampFilePath = path.join(
            this._env.userDirectory,
            "sync-tracker.json"
        );
        this._syncState = this._loadState();
    }

    /**
     * Gets the remote filename for tracking
     */
    public get remoteFilename(): string
    {
        return this._remoteFilename;
    }

    /**
     * Creates or gets the SyncTracker singleton instance
     */
    public static create(): SyncTracker
    {
        if (!SyncTracker._instance)
        {
            SyncTracker._instance = new SyncTracker();
        }
        return SyncTracker._instance;
    }

    /**
     * Gets the tracker content for uploading to remote
     */
    public getContent(): string
    {
        return JSON.stringify(this._syncState, null, 2);
    }

    /**
     * Updates the tracker with data received from remote
     * @param content Content of the remote file
     */
    public updateFromRemote(content: string): void
    {
        try
        {
            const remoteState = JSON.parse(content) as ISyncState;

            // If the remote timestamp is more recent than the local one, we use it
            if (remoteState.lastSyncTimestamp > this._syncState.lastSyncTimestamp)
            {
                console.log("[DEBUG] SyncTracker: Updating with more recent remote state");
                this._syncState = remoteState;
                this._saveState();
            }
            else
            {
                console.log("[DEBUG] SyncTracker: Local state more recent than remote");
            }
        }
        catch (err)
        {
            console.error("Error in remote update:", err);
        }
    }

    /**
     * Updates the timestamp and file hashes
     * @param files List of files with their contents
     */
    public updateSyncState(files: Record<string, string | Buffer>): void
    {
        // Update timestamp
        this._syncState.lastSyncTimestamp = Date.now();

        // Update file hashes
        for (const [filename, content] of Object.entries(files))
        {
            this._syncState.fileHashes[filename] = this._calculateHash(content);
        }

        // Save state
        this._saveState();
    }

    /**
     * Checks if remote files are actually different from local ones
     * @param files List of remote files with their contents
     * @param remoteTimestamp Remote timestamp
     * @returns True if download is necessary, false otherwise
     */
    public shouldDownload(files: Record<string, string | Buffer>, remoteTimestamp: number): boolean
    {
        // If we have never synchronized, we need to do it
        if (this._syncState.lastSyncTimestamp === 0)
        {
            console.log("[DEBUG] SyncTracker: First synchronization, download required");
            return true;
        }

        // If the remote timestamp is older than the local one, no need to download
        if (remoteTimestamp <= this._syncState.lastSyncTimestamp)
        {
            console.log("[DEBUG] SyncTracker: Remote timestamp not more recent, download not necessary");
            return false;
        }

        // Check if the content has actually changed
        let hasChanges = false;

        for (const [filename, content] of Object.entries(files))
        {
            const currentHash = this._calculateHash(content);
            const storedHash = this._syncState.fileHashes[filename];

            if (!storedHash || currentHash !== storedHash)
            {
                console.log(`[DEBUG] SyncTracker: Changes detected in file ${filename}`);
                hasChanges = true;
                break;
            }
        }

        if (!hasChanges)
        {
            console.log("[DEBUG] SyncTracker: No actual changes in files, download not necessary");
        }

        return hasChanges;
    }

    /**
     * Gets the last synchronization timestamp
     */
    public getLastSyncTimestamp(): number
    {
        return this._syncState.lastSyncTimestamp;
    }

    /**
     * Calculates a file hash
     * @param content File content
     */
    private _calculateHash(content: string | Buffer): string
    {
        const hash = crypto.createHash("md5");
        hash.update(content instanceof Buffer ? content : Buffer.from(content));
        return hash.digest("hex");
    }


    /**
     * Loads the synchronization state from file
     */
    private _loadState(): ISyncState
    {
        try
        {
            if (fs.existsSync(this._timestampFilePath))
            {
                const data = fs.readFileSync(this._timestampFilePath, "utf8");
                return JSON.parse(data);
            }
        }
        catch (err)
        {
            console.error("Error loading synchronization state:", err);
        }

        // Default state if file doesn't exist or is corrupted
        return {
            lastSyncTimestamp: 0,
            fileHashes: {}
        };
    }

    /**
     * Saves the synchronization state
     */
    private _saveState(): void
    {
        try
        {
            fs.writeFileSync(
                this._timestampFilePath,
                JSON.stringify(this._syncState, null, 2),
                "utf8"
            );
        }
        catch (err)
        {
            console.error("Error saving synchronization state:", err);
        }
    }
}
