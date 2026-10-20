/**
 * A fake vault for the sync engine's tests: Obsidian's folder tree, built
 * from a list of files.
 *
 * ⭐ It has no `getMarkdownFiles` and no `getFiles`. The engine lists only the
 * folders it syncs (`getFolderByPath`, then their children), so a change that
 * goes back to listing the whole vault throws in every test that syncs.
 */
import { TFile, TFolder } from 'obsidian';

export type FakeFile = { path: string; stat?: { mtime: number; ctime: number; size: number } };

const parentOf = (path: string): string =>
    path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Every folder in the tree the files make, by path ('/' is the root). A file
 * that is already a TFile goes into the tree as itself, so a test that moves
 * its own file objects sees them where they now are.
 */
export function folderTree(files: (FakeFile | TFile)[]): Map<string, TFolder> {
    const folders = new Map<string, TFolder>();
    const root = Object.assign(new (TFolder as unknown as new () => TFolder)(), { path: '/', name: '', children: [] });
    folders.set('/', root);

    const folderAt = (path: string): TFolder => {
        if (path === '') return root;
        const known = folders.get(path);
        if (known) return known;
        const folder = Object.assign(new (TFolder as unknown as new () => TFolder)(), {
            path, name: nameOf(path), children: [],
        });
        folderAt(parentOf(path)).children.push(folder);
        folders.set(path, folder);
        return folder;
    };

    for (const spec of files) {
        if (spec instanceof TFile) {
            folderAt(parentOf(spec.path)).children.push(spec);
            continue;
        }
        const name = nameOf(spec.path);
        const dot = name.lastIndexOf('.');
        const file = Object.assign(new (TFile as unknown as new () => TFile)(), {
            path: spec.path,
            name,
            basename: dot > 0 ? name.slice(0, dot) : name,
            extension: dot > 0 ? name.slice(dot + 1) : '',
            stat: spec.stat ?? { mtime: 0, ctime: 0, size: 10 },
        });
        folderAt(parentOf(spec.path)).children.push(file);
    }
    return folders;
}

/**
 * A vault holding whatever `files()` returns when it is asked, so a test can
 * change the files between syncs.
 */
export function fakeVault(files: () => FakeFile[]) {
    return {
        getFolderByPath: jest.fn((path: string) => folderTree(files()).get(path) ?? null),
        read: jest.fn(),
        on: jest.fn(),
        off: jest.fn(),
    };
}
