import { ExtensionContext } from 'vscode';
import path from 'path';

import * as newVersionNotifier from './newVersionNotifier';
import { closeEditorsAndCleanWorkspace } from '../test/testUtils';

describe('newVersionNotifier extension', () => {
  beforeEach(closeEditorsAndCleanWorkspace);

  afterEach(closeEditorsAndCleanWorkspace);

  it('should not fail on activate', () => {
    expect(() => {
      console.log('test', path.resolve(path.join(__dirname, '..', '..')));
      const mockContext = ({
        subscriptions: [],
        extensionPath: path.resolve(path.join(__dirname, '..', '..')),
      } as unknown) as ExtensionContext;
      newVersionNotifier.activate(mockContext);
      mockContext.subscriptions.forEach((sub) => sub.dispose());
    }).not.toThrow();
  });
});
