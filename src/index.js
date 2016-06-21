/*
 * Copyright 2015, Yahoo Inc.
 * Copyrights licensed under the New BSD License.
 * See the accompanying LICENSE file for terms.
 */

import * as p from 'path';
import {
    writeFileSync,
    readFileSync
} from 'fs';
import {
    sync as mkdirpSync
} from 'mkdirp';
import printICUMessage from './print-icu-message';

const COMPONENT_NAMES = [
    'FormattedMessage',
    'FormattedHTMLMessage',
    'Msg',
    'HtmlMsg'
];

const FUNCTION_NAMES = [
    'defineMessages',
    'msgs'
];

const DESCRIPTOR_PROPS = new Set(['id', 'description', 'defaultMessage']);

const INVALID_VALUE = Symbol();

const fileNameFromPath = ({ hub: { file: { opts: { filename } } } }) => filename;

export default function() {
    function getModuleSourceNames(opts) {
        return opts.moduleSourceNames || ['react-intl'];
    }

    function getComponentNames(opts) {
        return opts.componentNames || COMPONENT_NAMES;
    }

    function getFunctionNames(opts) {
        return opts.functionNames || FUNCTION_NAMES;
    }

    function getMessageDescriptorKey(path) {
        if (path.isIdentifier() || path.isJSXIdentifier()) {
            return path.node.name;
        }

        let evaluated = path.evaluate();
        if (evaluated.confident) {
            return evaluated.value;
        }

        console.warn(path.buildCodeFrameError(
            '[React Intl] Skipping key, messages must be statically evaluate-able for extraction. See ' + fileNameFromPath(path)
        ));

        return INVALID_VALUE;
    }

    function getMessageDescriptorValue(path) {
        if (path.isJSXExpressionContainer()) {
            path = path.get('expression');
        }

        let evaluated = path.evaluate();
        if (evaluated.confident) {
            return evaluated.value;
        }

        console.warn(path.buildCodeFrameError(
            '[React Intl] Skipping value, messages must be statically evaluate-able for extraction. See ' + fileNameFromPath(path)
        ));

        return INVALID_VALUE;
    }

    function createMessageDescriptor(propPaths, options = {}) {
        const {
            isJSXSource = false
        } = options;

        return propPaths.reduce((hash, [keyPath, valuePath]) => {
            let key = getMessageDescriptorKey(keyPath);

            if (!DESCRIPTOR_PROPS.has(key)) {
                return hash;
            }

            let value = getMessageDescriptorValue(valuePath);

            if (value === INVALID_VALUE) { 
                return hash;
            }

            if (key === 'defaultMessage') {
                try {
                    hash[key] = printICUMessage(value);
                } catch (parseError) {
                    if (isJSXSource &&
                        valuePath.isLiteral() &&
                        value.indexOf('\\\\') >= 0) {

                        throw valuePath.buildCodeFrameError(
                            '[React Intl] Message failed to parse. ' +
                            'It looks like `\\`s were used for escaping, ' +
                            'this won\'t work with JSX string literals. ' +
                            'Wrap with `{}`. ' +
                            'See: http://facebook.github.io/react/docs/jsx-gotchas.html'
                        );
                    }

                    throw valuePath.buildCodeFrameError(
                        '[React Intl] Message failed to parse. ' +
                        'See: http://formatjs.io/guides/message-syntax/',
                        parseError
                    );
                }
            } else {
                hash[key] = value;
            }

            return hash;
        }, {});
    }

    function storeMessage({
        id,
        description,
        defaultMessage
    }, path, state) {
        const {
            opts,
            reactIntl
        } = state;

        if (!(id && defaultMessage)) {
            throw path.buildCodeFrameError(
                '[React Intl] Message Descriptors require an `id` and `defaultMessage`.'
            );
        }

        if (reactIntl.messages.has(id)) {
            let existing = reactIntl.messages.get(id);

            if (description !== existing.description ||
                defaultMessage !== existing.defaultMessage) {

                throw path.buildCodeFrameError(
                    `[React Intl] Duplicate message id: "${id}", ` +
                    'but the `description` and/or `defaultMessage` are different.'
                );
            }
        }

        if (opts.enforceDescriptions && !description) {
            throw path.buildCodeFrameError(
                '[React Intl] Message must have a `description`.'
            );
        }

        reactIntl.messages.set(id, {
            id,
            description,
            defaultMessage
        });
    }

    function referencesImport(path, mods, importedNames) {
        if (!(path.isIdentifier() || path.isJSXIdentifier())) {
            return false;
        }

        return importedNames.some((name) => mods.some((mod) => path.referencesImport(mod, name)));
    }

    return {
        visitor: {
            Program: {
                enter(path, state) {
                    state.reactIntl = {
                        messages: new Map(),
                    };
                },

                exit(path, state) {
                    const {
                        file,
                        opts,
                        reactIntl,
                    } = state;
                    const {
                        basename,
                        filename
                    } = file.opts;

                    let descriptors = [...reactIntl.messages.values()];
                    file.metadata['react-intl'] = {
                        messages: descriptors
                    };

                    if (opts.messagesDir && descriptors.length > 0) {
                        // Make sure the relative path is "absolute" before
                        // joining it with the `messagesDir`.
                        let relativePath = p.join(
                            p.sep,
                            p.relative(process.cwd(), filename)
                        );

                        let messagesFilename = p.join(
                            opts.messagesDir,
                            p.dirname(relativePath),
                            basename + '.json'
                        );

                        let messagesFile = JSON.stringify(descriptors, null, 2);

                        mkdirpSync(p.dirname(messagesFilename));
                        writeFileSync(messagesFilename, messagesFile);
                    }
                },
            },

            JSXOpeningElement(path, state) {
                const {
                    file,
                    opts
                } = state;

                const moduleSourceNames = getModuleSourceNames(opts);

                let name = path.get('name');

                if (referencesImport(name, moduleSourceNames, ['FormattedPlural'])) {
                    file.log.warn(
                        `[React Intl] Line ${path.node.loc.start.line}: ` +
                        'Default messages are not extracted from ' +
                        '<FormattedPlural>, use <FormattedMessage> instead.'
                    );

                    return;
                }

                if (referencesImport(name, moduleSourceNames, COMPONENT_NAMES)) {
                    let attributes = path.get('attributes')
                        .filter((attr) => attr.isJSXAttribute());

                    let descriptor = createMessageDescriptor(
                        attributes.map((attr) => [
                            attr.get('name'),
                            attr.get('value'),
                        ]), {
                            isJSXSource: true
                        }
                    );

                    // In order for a default message to be extracted when
                    // declaring a JSX element, it must be done with standard
                    // `key=value` attributes. But it's completely valid to
                    // write `<FormattedMessage {...descriptor} />`, because it
                    // will be skipped here and extracted elsewhere. When the
                    // `defaultMessage` prop exists, the descriptor will be
                    // checked.
                    if (descriptor.defaultMessage) {
                        storeMessage(descriptor, path, state);
                    }
                }
            },

            // FIXME this does not seem to find `this.msg` calls. Investigate.
            CallExpression(path, state) {
                const moduleSourceNames = getModuleSourceNames(state.opts);
                const callee = path.get('callee');

                function assertObjectExpression(node) {
                    if (!(node && node.isObjectExpression())) {
                        throw path.buildCodeFrameError(
                            `[React Intl] \`${callee.node.name}()\` must be ` +
                            'called with an object expression with values ' +
                            'that are React Intl Message Descriptors, also ' +
                            'defined as object expressions.'
                        );
                    }
                }

                function processMessageObject(messageObj) {
                    assertObjectExpression(messageObj);

                    let properties = messageObj.get('properties');

                    let descriptor = createMessageDescriptor(
                        properties.map((prop) => [
                            prop.get('key'),
                            prop.get('value'),
                        ])
                    );

                    if (!descriptor.defaultMessage) {
                        throw path.buildCodeFrameError(
                            '[React Intl] Message is missing a `defaultMessage`.'
                        );
                    }

                    storeMessage(descriptor, path, state);
                }

                if (referencesImport(callee, moduleSourceNames, FUNCTION_NAMES)) {
                    const args = path.get('arguments');
                    let messagesObj = args[0];
                    // TODO here we need to discern whether the arguments are just
                    // one object or are we using the `this.msg` convention.
                    assertObjectExpression(messagesObj);
                    messagesObj.get('properties')
                        .map((prop) => prop.get('value'))
                        .forEach(processMessageObject);
                }
            },
        },
    };
}
