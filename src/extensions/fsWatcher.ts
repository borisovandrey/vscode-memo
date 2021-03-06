import fs from 'fs';
import path from 'path';
import { workspace, window, ExtensionContext } from 'vscode';
import groupBy from 'lodash.groupby';

import {
  fsPathToRef,
  getWorkspaceFolder,
  containsMarkdownExt,
  cacheWorkspace,
  getWorkspaceCache,
  escapeForRegExp,
  sortPaths,
  findAllUrisWithUnknownExts,
} from '../utils';

// TODO: Extract to utils
const replaceRefs = ({
  refs,
  content,
  onMatch,
  onReplace,
}: {
  refs: { old: string; new: string }[];
  content: string;
  onMatch?: () => void;
  onReplace?: () => void;
}): string | null => {
  const { updatedOnce, nextContent } = refs.reduce(
    ({ updatedOnce, nextContent }, ref) => {
      const pattern = `\\[\\[${escapeForRegExp(ref.old)}(\\|.*)?\\]\\]`;

      if (new RegExp(pattern, 'i').exec(content)) {
        onMatch && onMatch();

        const nextContent = content.replace(new RegExp(pattern, 'gi'), ($0, $1) => {
          onReplace && onReplace();

          return `[[${ref.new}${$1 || ''}]]`;
        });

        return {
          updatedOnce: true,
          nextContent,
        };
      }

      return {
        updatedOnce: updatedOnce,
        nextContent: nextContent,
      };
    },
    { updatedOnce: false, nextContent: content },
  );

  return updatedOnce ? nextContent : null;
};

export const activate = (context: ExtensionContext) => {
  const fileWatcher = workspace.createFileSystemWatcher('**/*.{md,png,jpg,jpeg,svg,gif}');

  const createListenerDisposable = fileWatcher.onDidCreate(cacheWorkspace);
  const deleteListenerDisposable = fileWatcher.onDidDelete(cacheWorkspace);

  const renameFilesDisposable = workspace.onDidRenameFiles(async ({ files }) => {
    await cacheWorkspace();

    if (files.some(({ newUri }) => fs.lstatSync(newUri.fsPath).isDirectory())) {
      window.showWarningMessage(
        'Recursive links update on directory rename is currently not supported.',
      );
    }

    const oldFsPaths = files.map(({ oldUri }) => oldUri.fsPath);

    const oldUrisByPathBasename = groupBy(
      sortPaths(
        [
          ...getWorkspaceCache().allUris.filter((uri) => !oldFsPaths.includes(uri.fsPath)),
          ...files.map(({ oldUri }) => oldUri),
        ],
        {
          pathKey: 'path',
          shallowFirst: true,
        },
      ),
      ({ fsPath }) => path.basename(fsPath).toLowerCase(),
    );

    const urisWithUnknownExts = await findAllUrisWithUnknownExts(files.map(({ newUri }) => newUri));

    const newUris = urisWithUnknownExts.length
      ? sortPaths([...getWorkspaceCache().allUris, ...urisWithUnknownExts], {
          pathKey: 'path',
          shallowFirst: true,
        })
      : getWorkspaceCache().allUris;

    const newUrisByPathBasename = groupBy(newUris, ({ fsPath }) =>
      path.basename(fsPath).toLowerCase(),
    );

    let pathsUpdated: string[] = [];

    let refsUpdated: number = 0;

    const addToPathsUpdated = (path: string) =>
      (pathsUpdated = [...new Set([...pathsUpdated, path])]);

    const incrementRefsCounter = () => (refsUpdated += 1);

    const isShortRefAllowed = (
      pathParam: string,
      urisByPathBasename: typeof newUrisByPathBasename,
    ) => {
      // Short ref allowed when non-unique filename comes first in the list of sorted uris.
      // Notice that note name is not required to be unique across multiple folders but only within a single folder.
      // /a.md - <-- can be referenced via short ref as [[a]], since it comes first according to paths sorting
      // /folder1/a.md - can be referenced only via long ref as [[folder1/a]]
      // /folder2/subfolder1/a.md - can be referenced only via long ref as [[folder2/subfolder1/a]]
      const urisGroup = urisByPathBasename[path.basename(pathParam).toLowerCase()] || [];
      return urisGroup.findIndex((uriParam) => uriParam.fsPath === pathParam) === 0;
    };

    files.forEach(({ oldUri, newUri }) => {
      const preserveOldExtension = !containsMarkdownExt(oldUri.fsPath);
      const preserveNewExtension = !containsMarkdownExt(newUri.fsPath);
      const workspaceFolder = getWorkspaceFolder()!;
      const oldShortRef = fsPathToRef({
        path: oldUri.fsPath,
        keepExt: preserveOldExtension,
      });
      const newShortRef = fsPathToRef({
        path: newUri.fsPath,
        keepExt: preserveNewExtension,
      });
      const oldLongRef = fsPathToRef({
        path: oldUri.fsPath,
        basePath: workspaceFolder,
        keepExt: preserveOldExtension,
      });
      const newLongRef = fsPathToRef({
        path: newUri.fsPath,
        basePath: workspaceFolder,
        keepExt: preserveNewExtension,
      });
      const oldUriIsShortRef = isShortRefAllowed(oldUri.fsPath, oldUrisByPathBasename);
      const newUriIsShortRef = isShortRefAllowed(newUri.fsPath, newUrisByPathBasename);

      if (!oldShortRef || !newShortRef || !oldLongRef || !newLongRef) {
        return;
      }

      newUris.forEach(({ fsPath: p }) => {
        const fileContent = fs.readFileSync(p).toString();
        let nextContent: string | null = null;

        if (!oldUriIsShortRef && !newUriIsShortRef) {
          // replace long ref with long ref
          // TODO: Consider finding previous short ref and make it pointing to the long ref
          nextContent = replaceRefs({
            refs: [{ old: oldLongRef, new: newLongRef }],
            content: fileContent,
            onMatch: () => addToPathsUpdated(p),
            onReplace: incrementRefsCounter,
          });
        } else if (!oldUriIsShortRef && newUriIsShortRef) {
          // replace long ref with short ref
          nextContent = replaceRefs({
            refs: [{ old: oldLongRef, new: newShortRef }],
            content: fileContent,
            onMatch: () => addToPathsUpdated(p),
            onReplace: incrementRefsCounter,
          });
        } else if (oldUriIsShortRef && !newUriIsShortRef) {
          // replace short ref with long ref
          // TODO: Consider finding new short ref and making long refs pointing to the new short ref
          nextContent = replaceRefs({
            refs: [{ old: oldShortRef, new: newLongRef }],
            content: fileContent,
            onMatch: () => addToPathsUpdated(p),
            onReplace: incrementRefsCounter,
          });
        } else {
          // replace short ref with short ref
          nextContent = replaceRefs({
            refs: [{ old: oldShortRef, new: newShortRef }],
            content: fileContent,
            onMatch: () => addToPathsUpdated(p),
            onReplace: incrementRefsCounter,
          });
        }

        if (nextContent !== null) {
          fs.writeFileSync(p, nextContent);
        }
      });
    });

    if (pathsUpdated.length > 0) {
      window.showInformationMessage(
        `Updated ${refsUpdated} link${refsUpdated === 0 || refsUpdated === 1 ? '' : 's'} in ${
          pathsUpdated.length
        } file${pathsUpdated.length === 0 || pathsUpdated.length === 1 ? '' : 's'}`,
      );
    }
  });

  context.subscriptions.push(
    createListenerDisposable,
    deleteListenerDisposable,
    renameFilesDisposable,
  );
};
