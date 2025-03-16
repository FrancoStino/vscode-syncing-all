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
 * Classe che gestisce il tracciamento intelligente della sincronizzazione
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
        // Creiamo il file nella stessa directory delle impostazioni utente
        this._timestampFilePath = path.join(
            this._env.userDirectory,
            "sync-tracker.json"
        );
        this._syncState = this._loadState();
    }

    /**
     * Ottiene il nome del file remoto per il tracking
     */
    public get remoteFilename(): string
    {
        return this._remoteFilename;
    }

    /**
     * Crea o ottiene l'istanza singleton di SyncTracker
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
     * Ottiene il contenuto del tracker per il caricamento su remoto
     */
    public getContent(): string
    {
        return JSON.stringify(this._syncState, null, 2);
    }

    /**
     * Aggiorna il tracker con i dati ricevuti dal remoto
     * @param content Contenuto del file remoto
     */
    public updateFromRemote(content: string): void
    {
        try
        {
            const remoteState = JSON.parse(content) as ISyncState;

            // Se il timestamp remoto è più recente di quello locale, lo usiamo
            if (remoteState.lastSyncTimestamp > this._syncState.lastSyncTimestamp)
            {
                console.log("[DEBUG] SyncTracker: Aggiornamento con stato remoto più recente");
                this._syncState = remoteState;
                this._saveState();
            }
            else
            {
                console.log("[DEBUG] SyncTracker: Stato locale più recente del remoto");
            }
        }
        catch (err)
        {
            console.error("Errore nell'aggiornamento da remoto:", err);
        }
    }

    /**
     * Aggiorna il timestamp e gli hash dei file
     * @param files Elenco dei file con i loro contenuti
     */
    public updateSyncState(files: Record<string, string | Buffer>): void
    {
        // Aggiorna il timestamp
        this._syncState.lastSyncTimestamp = Date.now();

        // Aggiorna gli hash dei file
        for (const [filename, content] of Object.entries(files))
        {
            this._syncState.fileHashes[filename] = this._calculateHash(content);
        }

        // Salva lo stato
        this._saveState();
    }

    /**
     * Verifica se i file remoti sono effettivamente diversi da quelli locali
     * @param files Elenco dei file remoti con i loro contenuti
     * @param remoteTimestamp Timestamp remoto
     * @returns True se è necessario scaricare, false altrimenti
     */
    public shouldDownload(files: Record<string, string | Buffer>, remoteTimestamp: number): boolean
    {
        // Se non abbiamo mai sincronizzato, dobbiamo farlo
        if (this._syncState.lastSyncTimestamp === 0)
        {
            console.log("[DEBUG] SyncTracker: Prima sincronizzazione, download necessario");
            return true;
        }

        // Se il timestamp remoto è più vecchio di quello locale, non serve scaricare
        if (remoteTimestamp <= this._syncState.lastSyncTimestamp)
        {
            console.log("[DEBUG] SyncTracker: Timestamp remoto non più recente, download non necessario");
            return false;
        }

        // Verifica se il contenuto è effettivamente cambiato
        let hasChanges = false;

        for (const [filename, content] of Object.entries(files))
        {
            const currentHash = this._calculateHash(content);
            const storedHash = this._syncState.fileHashes[filename];

            if (!storedHash || currentHash !== storedHash)
            {
                console.log(`[DEBUG] SyncTracker: Rilevate modifiche nel file ${filename}`);
                hasChanges = true;
                break;
            }
        }

        if (!hasChanges)
        {
            console.log("[DEBUG] SyncTracker: Nessuna modifica effettiva nei file, download non necessario");
        }

        return hasChanges;
    }

    /**
     * Ottiene l'ultimo timestamp di sincronizzazione
     */
    public getLastSyncTimestamp(): number
    {
        return this._syncState.lastSyncTimestamp;
    }

    /**
     * Calcola l'hash di un file
     * @param content Contenuto del file
     */
    private _calculateHash(content: string | Buffer): string
    {
        const hash = crypto.createHash("md5");
        hash.update(content instanceof Buffer ? content : Buffer.from(content));
        return hash.digest("hex");
    }


    /**
     * Carica lo stato di sincronizzazione dal file
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
            console.error("Errore nel caricamento dello stato di sincronizzazione:", err);
        }

        // Stato predefinito se il file non esiste o è corrotto
        return {
            lastSyncTimestamp: 0,
            fileHashes: {}
        };
    }

    /**
     * Salva lo stato di sincronizzazione
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
            console.error("Errore nel salvataggio dello stato di sincronizzazione:", err);
        }
    }
}
