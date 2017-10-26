import { inject, injectable } from 'inversify';
import { DeclarationInfo, TypescriptParser } from 'typescript-parser';
import { commands, ExtensionContext, StatusBarAlignment, StatusBarItem, window, workspace } from 'vscode';

import { getDeclarationsFilteredByImports } from '../../common/helpers';
import { ResolveQuickPickItem } from '../../common/quick-pick-items';
import { Logger, LoggerFactory } from '../../common/utilities';
import { iocSymbols } from '../IoCSymbols';
import { ImportManager } from '../managers';
import { DeclarationIndexMapper } from '../utilities/DeclarationIndexMapper';
import { BaseExtension } from './BaseExtension';

type DeclarationsForImportOptions = { cursorSymbol: string, documentSource: string, documentPath: string };
type MissingDeclarationsForFileOptions = { documentSource: string, documentPath: string };

const resolverOk = 'TSH Resolver $(check)';
const resolverSyncing = 'TSH Resolver $(sync)';
const resolverErr = 'TSH Resolver $(flame)';

/**
 * Extension that resolves imports. Contains various actions to add imports to a document, add missing
 * imports and organize imports. Also can rebuild the symbol cache.
 *
 * @export
 * @class ImportResolveExtension
 * @extends {BaseExtension}
 */
@injectable()
export class ImportResolveExtension extends BaseExtension {
    private logger: Logger;
    private statusBarItem: StatusBarItem = window.createStatusBarItem(StatusBarAlignment.Left, 4);

    constructor(
        @inject(iocSymbols.extensionContext) context: ExtensionContext,
        @inject(iocSymbols.loggerFactory) loggerFactory: LoggerFactory,
        @inject(iocSymbols.typescriptParser) private parser: TypescriptParser,
        @inject(iocSymbols.declarationIndexMapper) private indices: DeclarationIndexMapper,
    ) {
        super(context);
        this.logger = loggerFactory('ImportResolveExtension');
    }

    /**
     * Initialized the extension. Registers the commands and other disposables to the context.
     *
     * @memberof ImportResolveExtension
     */
    public initialize(): void {
        this.context.subscriptions.push(this.statusBarItem);

        this.statusBarItem.text = resolverOk;
        this.statusBarItem.tooltip = 'Click to manually reindex all files';
        this.statusBarItem.command = 'typescriptHero.resolve.rebuildCache';
        this.context.subscriptions.push(this.indices.onStartIndexing(() => {
            this.statusBarItem.text = resolverSyncing;
        }));
        this.context.subscriptions.push(this.indices.onFinishIndexing(() => {
            this.statusBarItem.text = resolverOk;
        }));
        this.context.subscriptions.push(this.indices.onIndexingError(() => {
            this.statusBarItem.text = resolverErr;
        }));
        this.statusBarItem.show();

        this.commandRegistrations();

        this.logger.info('Initialized');
    }

    /**
     * Disposes the extension.
     *
     * @memberof ImportResolveExtension
     */
    public dispose(): void {
        this.logger.info('Disposed');
    }

    /**
     * Add an import from the whole list. Calls the vscode gui, where the user can
     * select a symbol to import.
     *
     * @private
     * @returns {Promise<void>}
     *
     * @memberof ResolveExtension
     */
    private async addImport(): Promise<void> {
        if (!window.activeTextEditor) {
            return;
        }
        const index = this.indices.getIndexForFile(window.activeTextEditor.document.uri);
        if (!index || !index.indexReady) {
            this.showCacheWarning();
            return;
        }
        try {
            const selectedItem = await window.showQuickPick(
                index.declarationInfos.map(o => new ResolveQuickPickItem(o)),
                { placeHolder: 'Add import to document:' },
            );
            if (selectedItem) {
                this.logger.info('Add import to document', { resolveItem: selectedItem });
                this.addImportToDocument(selectedItem.declarationInfo);
            }
        } catch (e) {
            this.logger.error('An error happend during import picking', e);
            window.showErrorMessage('The import cannot be completed, there was an error during the process.');
        }
    }

    /**
     * Add an import from the whole list. Calls the vscode gui, where the user can
     * select a symbol to import.
     *
     * @private
     * @returns {Promise<void>}
     *
     * @memberof ImportResolveExtension
     */
    private async addImportUnderCursor(): Promise<void> {
        if (!window.activeTextEditor) {
            return;
        }
        const index = this.indices.getIndexForFile(window.activeTextEditor.document.uri);
        if (!index || !index.indexReady) {
            this.showCacheWarning();
            return;
        }
        try {
            const selectedSymbol = this.getSymbolUnderCursor();
            if (!!!selectedSymbol) {
                return;
            }
            const resolveItems = await this.getDeclarationsForImport({
                cursorSymbol: selectedSymbol,
                documentSource: window.activeTextEditor.document.getText(),
                documentPath: window.activeTextEditor.document.fileName,
            });

            if (resolveItems.length < 1) {
                window.showInformationMessage(
                    `The symbol '${selectedSymbol}' was not found in the index or is already imported.`,
                );
            } else if (resolveItems.length === 1 && resolveItems[0].declaration.name === selectedSymbol) {
                this.logger.info('Add import to document', { resolveItem: resolveItems[0] });
                this.addImportToDocument(resolveItems[0]);
            } else {
                const selectedItem = await window.showQuickPick(
                    resolveItems.map(o => new ResolveQuickPickItem(o)), { placeHolder: 'Multiple declarations found:' },
                );
                if (selectedItem) {
                    this.logger.info('Add import to document', { resolveItem: selectedItem });
                    this.addImportToDocument(selectedItem.declarationInfo);
                }
            }
        } catch (e) {
            this.logger.error('An error happend during import picking', e);
            window.showErrorMessage('The import cannot be completed, there was an error during the process.');
        }
    }

    /**
     * Adds all missing imports to the actual document if possible. If multiple declarations are found,
     * a quick pick list is shown to the user and he needs to decide, which import to use.
     *
     * @private
     * @returns {Promise<void>}
     *
     * @memberof ImportResolveExtension
     */
    private async addMissingImports(): Promise<void> {
        if (!window.activeTextEditor) {
            return;
        }
        const index = this.indices.getIndexForFile(window.activeTextEditor.document.uri);
        if (!index || !index.indexReady) {
            this.showCacheWarning();
            return;
        }
        try {
            const missing = await this.getMissingDeclarationsForFile({
                documentSource: window.activeTextEditor.document.getText(),
                documentPath: window.activeTextEditor.document.fileName,
            });

            if (missing && missing.length) {
                const ctrl = await ImportManager.create(window.activeTextEditor.document);
                missing.filter(o => o instanceof DeclarationInfo).forEach(o => ctrl.addDeclarationImport(<any>o));
                await ctrl.commit();
            }
        } catch (e) {
            this.logger.error('An error happend during import fixing', e);
            window.showErrorMessage('The operation cannot be completed, there was an error during the process.');
        }
    }

    /**
     * Organizes the imports of the actual document. Sorts and formats them correctly.
     *
     * @private
     * @returns {Promise<boolean>}
     *
     * @memberof ImportResolveExtension
     */
    private async organizeImports(): Promise<boolean> {
        if (!window.activeTextEditor) {
            return false;
        }
        try {
            const ctrl = await ImportManager.create(window.activeTextEditor.document);
            return await ctrl.organizeImports().commit();
        } catch (e) {
            this.logger.error('An error happend during "organize imports".', { error: e });
            return false;
        }
    }

    /**
     * Effectifely adds an import quick pick item to a document
     *
     * @private
     * @param {DeclarationInfo} declaration
     * @returns {Promise<boolean>}
     *
     * @memberof ImportResolveExtension
     */
    private async addImportToDocument(declaration: DeclarationInfo): Promise<boolean> {
        if (!window.activeTextEditor) {
            return false;
        }
        const ctrl = await ImportManager.create(window.activeTextEditor.document);
        return await ctrl.addDeclarationImport(declaration).commit();
    }

    /**
     * Returns the string under the cursor.
     *
     * @private
     * @returns {string}
     *
     * @memberof ImportResolveExtension
     */
    private getSymbolUnderCursor(): string {
        const editor = window.activeTextEditor;
        if (!editor) {
            return '';
        }
        const selection = editor.selection;
        const word = editor.document.getWordRangeAtPosition(selection.active);

        return word && !word.isEmpty ? editor.document.getText(word) : '';
    }

    /**
     * Shows a user warning if the resolve index is not ready yet.
     *
     * @private
     *
     * @memberof ImportResolveExtension
     */
    private showCacheWarning(): void {
        window.showWarningMessage('Please wait a few seconds longer until the symbol cache has been build.');
    }

    /**
     * Calculates the possible imports for a given document source with a filter for the given symbol.
     * Returns a list of declaration infos that may be used for select picker or something.
     *
     * @private
     * @param {DeclarationsForImportOptions} {cursorSymbol, documentSource, documentPath}
     * @returns {(Promise<DeclarationInfo[] | undefined>)}
     *
     * @memberof ImportResolveExtension
     */
    private async getDeclarationsForImport(
        { cursorSymbol, documentSource, documentPath }: DeclarationsForImportOptions,
    ): Promise<DeclarationInfo[]> {
        this.logger.info(`Calculate possible imports for document with filter "${cursorSymbol}"`);
        if (!window.activeTextEditor) {
            return [];
        }

        const index = this.indices.getIndexForFile(window.activeTextEditor.document.uri);
        const rootFolder = workspace.getWorkspaceFolder(window.activeTextEditor.document.uri);

        if (!index || !index.indexReady || !rootFolder) {
            return [];
        }

        const parsedSource = await this.parser.parseSource(documentSource);
        const activeDocumentDeclarations = parsedSource.declarations.map(o => o.name);
        const declarations = getDeclarationsFilteredByImports(
            index.declarationInfos,
            documentPath,
            parsedSource.imports,
            rootFolder.uri.fsPath,
        ).filter(o => o.declaration.name.startsWith(cursorSymbol));

        return [
            ...declarations.filter(o => o.from.startsWith('/')),
            ...declarations.filter(o => !o.from.startsWith('/')),
        ].filter(o => activeDocumentDeclarations.indexOf(o.declaration.name) === -1);
    }

    /**
     * Calculates the missing imports of a document. Parses the documents source and then
     * tries to resolve all possible declaration infos for the usages (used identifiers).
     *
     * @private
     * @param {MissingDeclarationsForFileOptions} {documentSource, documentPath}
     * @returns {(Promise<(DeclarationInfo | ImportUserDecision)[]>)}
     *
     * @memberof ImportResolveExtension
     */
    private async getMissingDeclarationsForFile(
        { documentSource, documentPath }: MissingDeclarationsForFileOptions,
    ): Promise<(DeclarationInfo)[]> {
        if (!window.activeTextEditor) {
            return [];
        }

        const index = this.indices.getIndexForFile(window.activeTextEditor.document.uri);
        const rootFolder = workspace.getWorkspaceFolder(window.activeTextEditor.document.uri);

        if (!index || !index.indexReady || !rootFolder) {
            return [];
        }

        const parsedDocument = await this.parser.parseSource(documentSource);
        const missingDeclarations: (DeclarationInfo)[] = [];
        const declarations = getDeclarationsFilteredByImports(
            index.declarationInfos,
            documentPath,
            parsedDocument.imports,
            rootFolder.uri.fsPath,
        );

        for (const usage of parsedDocument.nonLocalUsages) {
            const foundDeclarations = declarations.filter(o => o.declaration.name === usage);
            if (foundDeclarations.length <= 0) {
                continue;
            } else if (foundDeclarations.length === 1) {
                missingDeclarations.push(foundDeclarations[0]);
            } else {
                // TODO handle decisions.
                // missingDeclarations.push(...foundDeclarations.map(o => new ImportUserDecision(o, usage)));
            }
        }

        return missingDeclarations;
    }

    /**
     * Registers the commands for this extension.
     *
     * @private
     * @memberof ImportResolveExtension
     */
    private commandRegistrations(): void {
        this.context.subscriptions.push(
            commands.registerTextEditorCommand('typescriptHero.resolve.addImport', () => this.addImport()),
        );
        this.context.subscriptions.push(
            commands.registerTextEditorCommand(
                'typescriptHero.resolve.addImportUnderCursor',
                () => this.addImportUnderCursor(),
            ),
        );
        this.context.subscriptions.push(
            commands.registerTextEditorCommand(
                'typescriptHero.resolve.addMissingImports', () => this.addMissingImports(),
            ),
        );
        this.context.subscriptions.push(
            commands.registerTextEditorCommand('typescriptHero.resolve.organizeImports', () => this.organizeImports()),
        );
        this.context.subscriptions.push(
            commands.registerCommand('typescriptHero.resolve.rebuildCache', () => this.indices.rebuildAll()),
        );
    }
}
