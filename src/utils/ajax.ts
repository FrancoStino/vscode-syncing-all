import * as fs from "fs-extra";
import * as https from "https";
import * as HttpsProxyAgent from "https-proxy-agent";
import * as url from "url";
import * as zlib from "zlib";

import { isEmptyString } from "./lang";

/**
 * Posts a request.
 *
 * @param {string} api The post url.
 * @param {any} data The post data.
 * @param {any} headers The headers.
 * @param {string} [proxy] The proxy settings.
 */
export function post(api: string, data: any, headers: any, proxy?: string): Promise<string>
{
    return new Promise((resolve, reject) =>
    {
        const body: string = JSON.stringify(data);
        const { host, path, port } = url.parse(api);
        const options: https.RequestOptions = {
            host,
            path,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": body.length,
                ...headers
            }
        };

        if (port)
        {
            options.port = +port;
        }

        if (proxy != null && !isEmptyString(proxy))
        {
            options.agent = new HttpsProxyAgent(proxy);
        }

        const req = https.request(options, (res) =>
        {
            if (res.statusCode === 200)
            {
                let result = "";
                res.on("data", (chunk) =>
                {
                    result += chunk;
                });

                res.on("end", () =>
                {
                    resolve(result);
                });
            }
            else
            {
                reject();
            }
        }).on("error", (err) =>
        {
            reject(err);
        });

        req.write(body);
        req.end();
    });
}

/**
 * Downloads a file.
 *
 * @param {string} uri The resource uri.
 * @param {string} savepath The path where the file will be saved;
 * @param {string} [proxy] The proxy settings.
 */
export function downloadFile(uri: string, savepath: string, proxy?: string): Promise<void>
{
    return new Promise((resolve, reject) =>
    {
        const { host, path, port } = url.parse(uri);
        const options: https.RequestOptions = { host, path };

        if (port)
        {
            options.port = +port;
        }

        if (proxy != null && !isEmptyString(proxy))
        {
            options.agent = new HttpsProxyAgent(proxy);
        }

        const file = fs.createWriteStream(savepath);
        file.on("finish", () =>
        {
            file.close();
            resolve();
        });
        https.get(options, (res) =>
        {
            if (res.statusCode === 200)
            {
                let intermediate: zlib.Gunzip | zlib.Inflate | undefined;
                const contentEncoding = res.headers["content-encoding"];
                if (contentEncoding === "gzip")
                {
                    intermediate = zlib.createGunzip();
                }
                else if (contentEncoding === "deflate")
                {
                    intermediate = zlib.createInflate();
                }

                if (intermediate)
                {
                    res.pipe(intermediate).pipe(file);
                }
                else
                {
                    res.pipe(file);
                }
            }
            else
            {
                reject();
            }
        }).on("error", (err) =>
        {
            // Close and remove the temp file.
            file.close();
            fs.remove(savepath).catch().then(() => reject(err));
        });
    });
}
