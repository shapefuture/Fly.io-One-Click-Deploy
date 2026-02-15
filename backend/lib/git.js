import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import tar from 'tar';
import { Readable } from 'stream';

export async function downloadRepo(repoUrl, targetDir, githubToken) {
    const cleanUrl = repoUrl.replace(/\.git$/, '').replace(/\/$/, '');
    const archiveUrl = `${cleanUrl}/archive/HEAD.tar.gz`;
    const headers = githubToken ? { 'Authorization': `token ${githubToken}` } : {};

    console.log(`[Git] Streaming download from ${archiveUrl}...`);
    
    const res = await fetch(archiveUrl, { headers });
    if (!res.ok) {
        if (res.status === 404) throw new Error("Repository not found or private (check token).");
        throw new Error(`Repo download failed: ${res.status}`);
    }

    // Streaming extraction (Memory Safe)
    await new Promise((resolve, reject) => {
        if (!res.body) return reject(new Error("No response body"));
        
        // Convert Web Stream to Node Stream if necessary
        const stream = res.body instanceof Readable ? res.body : Readable.fromWeb(res.body);
        
        stream.pipe(
            tar.x({
                cwd: targetDir,
                strip: 1 // GitHub archives are nested in a root folder (e.g. repo-main/), this strips it
            })
        )
        .on('finish', resolve)
        .on('error', reject);
    });
    
    // Fallback: If strip:1 failed (repo empty or flat?), verify content
    const list = await fs.readdir(targetDir);
    if (list.length === 0) throw new Error("Repository is empty.");
    
    return targetDir;
}
