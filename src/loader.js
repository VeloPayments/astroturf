import { dirname } from 'path';
import util from 'util';
import chalk from 'chalk';
import levenshtein from 'fast-levenshtein';
import loaderUtils from 'loader-utils';
import { codeFrameColumns } from '@babel/code-frame';

import traverse from './traverse';
import { getNameFromFile } from './utils/createFilename';
import VirtualModulePlugin from './VirtualModulePlugin';

const debug = util.debuglog('astroturf:loader');

// can'ts use class syntax b/c babel doesn't transpile it correctly for Error
function AstroturfLoaderError(
  errorOrMessage,
  codeFrame = errorOrMessage.codeFrame,
) {
  Error.call(this);
  this.name = 'AstroturfLoaderError';

  if (typeof errorOrMessage !== 'string') {
    this.message = errorOrMessage.message;
    this.error = errorOrMessage;

    try {
      this.stack = errorOrMessage.stack.replace(/^(.*?):/, `${this.name}:`);
    } catch (err) {
      Error.captureStackTrace(this, AstroturfLoaderError);
    }
  } else {
    this.message = errorOrMessage;
    Error.captureStackTrace(this, AstroturfLoaderError);
  }

  if (codeFrame) this.message += `\n\n${codeFrame}\n`;
}

AstroturfLoaderError.prototype = Object.create(Error.prototype);
AstroturfLoaderError.prototype.constructor = AstroturfLoaderError;

function buildDependencyError(
  content,
  { type, identifier, request },
  { styles, resource },
  loc,
) {
  let idents = styles.map(s => s.identifier);

  let closest;
  let minDistance = 2;
  idents.forEach(ident => {
    const d = levenshtein.get(ident, identifier);
    if (d < minDistance) {
      minDistance = d;
      closest = ident;
    }
  });
  const isDefaultImport = type === 'ImportDefaultSpecifier';

  if (!closest && isDefaultImport) {
    closest = idents.find(ident => ident === getNameFromFile(resource));
  }
  if (closest) idents = idents.filter(ident => ident !== closest);

  idents = idents.map(s => chalk.yellow(s)).join(', ');

  const alternative = isDefaultImport
    ? `Instead try: ${chalk.yellow(`import ${closest} from '${request}';`)}`
    : `Did you mean to import as ${chalk.yellow(closest)} instead?`;

  return new AstroturfLoaderError(
    // eslint-disable-next-line prefer-template
    `Could not find a style associated with the interpolated value. ` +
      `Styles should use the same name used by the intended component or class set in the imported file.\n\n` +
      codeFrameColumns(
        content,
        { start: loc.start },
        {
          highlightCode: true,
          message: !isDefaultImport
            ? `(Imported as ${chalk.bold(identifier)})`
            : '',
        },
      ) +
      `\n\n${
        closest
          ? `${alternative}\n\nAlso available: ${idents}`
          : `Available: ${idents}`
      }`,
  );
}

function collectStyles(src, filename, resolveDependency, opts) {
  const tagName = opts.tagName || 'css';
  const styledTag = opts.styledTag || 'styled';

  // quick regex as an optimization to avoid parsing each file
  if (
    !src.match(
      new RegExp(
        `(${tagName}|${styledTag}(.|\\n|\\r)+?)\\s*\`([\\s\\S]*?)\``,
        'gmi',
      ),
    ) &&
    opts.cssPropEnabled &&
    !src.match(/css=("|')/g)
  ) {
    return { styles: [] };
  }

  // maybe eventually return the ast directly if babel-loader supports it
  try {
    const { metadata } = traverse(src, filename, {
      ...opts,
      resolveDependency,
      writeFiles: false,
      generateInterpolations: true,
    });
    return metadata.astroturf;
  } catch (err) {
    throw new AstroturfLoaderError(err);
  }
}

function replaceStyleTemplates(src, locations) {
  let offset = 0;

  function splice(str, start = 0, end = 0, replace) {
    const result =
      str.slice(0, start + offset) + replace + str.slice(end + offset);

    offset += replace.length - (end - start);
    return result;
  }

  locations.forEach(({ start, end, code }) => {
    if (code.endsWith(';')) code = code.slice(0, -1); // remove trailing semicolon
    src = splice(src, start, end, code);
  });

  return src;
}

const LOADER_PLUGIN = Symbol('loader added VM plugin');
const SEEN = Symbol('astroturf seen modules');

module.exports = function loader(content, map, meta) {
  const { resourcePath, _compilation: compilation } = this;
  const cb = this.async();

  if (!compilation[SEEN]) compilation[SEEN] = new Set();

  const resolve = util.promisify((request, done) => {
    this.resolve(dirname(resourcePath), request, (err, resource) => {
      if (err) {
        done(err);
        return;
      }

      if (compilation[SEEN].has(resource)) {
        done(
          new AstroturfLoaderError(
            'A cyclical style interpolation was detected in an interpolated stylesheet or component which is not supported.\n' +
              `while importing "${request}" in ${resourcePath}`,
          ),
        );
        return;
      }

      this.loadModule(resource, (err2, _, __, module) => {
        // console.log('HERE', args);
        done(err2, module);
      });
    });
  });

  return (async () => {
    const options = loaderUtils.getOptions(this) || {};
    const dependencies = [];

    function resolveDependency(interpolation, localStyle, node) {
      const { identifier, request } = interpolation;
      if (!interpolation.identifier) return null;
      const { loc } = node;

      const memberProperty = node.property && node.property.name;

      const imported = `###ASTROTURF_IMPORTED_${dependencies.length}###`;
      const source = `###ASTROTURF_SOURCE_${dependencies.length}###`;

      debug(`resolving dependency: ${request}`);
      dependencies.push(
        resolve(request).then(module => {
          const style = module.styles.find(s => s.identifier === identifier);

          if (!style) {
            throw buildDependencyError(content, interpolation, module, loc);
          }

          debug(`resolved request to: ${style.absoluteFilePath}`);
          localStyle.value = localStyle.value
            .replace(source, `~${style.absoluteFilePath}`)
            .replace(
              imported,
              style.isStyledComponent ? 'cls1' : memberProperty,
            );
        }),
      );

      return { source, imported };
    }
    const { styles = [], changeset } = collectStyles(
      content,
      resourcePath,
      resolveDependency,
      options,
    );

    if (meta) {
      meta.styles = styles;
    }

    if (!styles.length) return content;

    compilation[SEEN].add(resourcePath);

    this._module.styles = styles;

    let { emitVirtualFile } = this;

    // The plugin isn't loaded
    if (!emitVirtualFile) {
      const { compiler } = compilation;
      let plugin = compiler[LOADER_PLUGIN];
      if (!plugin) {
        debug('adding plugin to compiiler');
        plugin = VirtualModulePlugin.bootstrap(compilation);
        compiler[LOADER_PLUGIN] = plugin;
      }
      emitVirtualFile = plugin.addFile;
    }

    await Promise.all(dependencies);

    styles.forEach(style => {
      emitVirtualFile(style.absoluteFilePath, style.value);
    });

    return replaceStyleTemplates(content, changeset);
  })().then(result => cb(null, result), cb);
};
