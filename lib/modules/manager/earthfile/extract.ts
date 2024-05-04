import is from '@sindresorhus/is';
import { logger } from '../../../logger';
import { escapeRegExp, newlineRegex, regEx } from '../../../util/regex';
import { DockerDatasource } from '../../datasource/docker';
import * as debianVersioning from '../../versioning/debian';
import * as ubuntuVersioning from '../../versioning/ubuntu';
import type {
  ExtractConfig,
  PackageDependency,
  PackageFileContent,
} from '../types';

const variableMarker = '$';

export function extractVariables(image: string): Record<string, string> {
  const variables: Record<string, string> = {};
  const variableRegex = regEx(
    /(?<fullvariable>\\?\$(?<simplearg>\w+)|\\?\${(?<complexarg>\w+)(?::.+?)?}+)/gi,
  );

  let match: RegExpExecArray | null;
  do {
    match = variableRegex.exec(image);
    if (match?.groups?.fullvariable) {
      variables[match.groups.fullvariable] =
        match.groups?.simplearg || match.groups?.complexarg;
    }
  } while (match);

  return variables;
}

function getAutoReplaceTemplate(dep: PackageDependency): string | undefined {
  let template = dep.replaceString;

  if (dep.currentValue) {
    let placeholder = '{{#if newValue}}{{newValue}}{{/if}}';
    if (!dep.currentDigest) {
      placeholder += '{{#if newDigest}}@{{newDigest}}{{/if}}';
    }
    template = template?.replace(dep.currentValue, placeholder);
  }

  if (dep.currentDigest) {
    template = template?.replace(
      dep.currentDigest,
      '{{#if newDigest}}{{newDigest}}{{/if}}',
    );
  }

  return template;
}

function processDepForAutoReplace(
  dep: PackageDependency,
  lineNumberRanges: number[][],
  lines: string[],
  linefeed: string,
): void {
  const lineNumberRangesToReplace: number[][] = [];
  for (const lineNumberRange of lineNumberRanges) {
    for (const lineNumber of lineNumberRange) {
      if (
        (is.string(dep.currentValue) &&
          lines[lineNumber].includes(dep.currentValue)) ||
        (is.string(dep.currentDigest) &&
          lines[lineNumber].includes(dep.currentDigest))
      ) {
        lineNumberRangesToReplace.push(lineNumberRange);
      }
    }
  }

  lineNumberRangesToReplace.sort((a, b) => {
    return a[0] - b[0];
  });

  const minLine = lineNumberRangesToReplace[0]?.[0];
  const maxLine =
    lineNumberRangesToReplace[lineNumberRangesToReplace.length - 1]?.[1];
  if (
    lineNumberRanges.length === 1 ||
    minLine === undefined ||
    maxLine === undefined
  ) {
    return;
  }

  const unfoldedLineNumbers = Array.from(
    { length: maxLine - minLine + 1 },
    (_v, k) => k + minLine,
  );

  dep.replaceString = unfoldedLineNumbers
    .map((lineNumber) => lines[lineNumber])
    .join(linefeed);

  if (!dep.currentDigest) {
    dep.replaceString += linefeed;
  }

  dep.autoReplaceStringTemplate = getAutoReplaceTemplate(dep);
}

export function splitImageParts(currentFrom: string): PackageDependency {
  let isVariable = false;
  let cleanedCurrentFrom = currentFrom;

  // Check if we have a variable in format of "${VARIABLE:-<image>:<defaultVal>@<digest>}"
  // If so, remove everything except the image, defaultVal and digest.
  if (cleanedCurrentFrom?.includes(variableMarker)) {
    const defaultValueRegex = regEx(/^\${.+?:-"?(?<value>.*?)"?}$/);
    const defaultValueMatch =
      defaultValueRegex.exec(cleanedCurrentFrom)?.groups;
    if (defaultValueMatch?.value) {
      isVariable = true;
      cleanedCurrentFrom = defaultValueMatch.value;
    }

    if (cleanedCurrentFrom?.includes(variableMarker)) {
      // If cleanedCurrentFrom contains a variable, after cleaning, e.g. "$REGISTRY/alpine", we do not support this.
      return {
        skipReason: 'contains-variable',
      };
    }
  }

  const [currentDepTag, currentDigest] = cleanedCurrentFrom.split('@');
  const depTagSplit = currentDepTag.split(':');
  let depName: string;
  let currentValue: string | undefined;
  if (
    depTagSplit.length === 1 ||
    depTagSplit[depTagSplit.length - 1].includes('/')
  ) {
    depName = currentDepTag;
  } else {
    currentValue = depTagSplit.pop();
    depName = depTagSplit.join(':');
  }

  const dep: PackageDependency = {
    depName,
    currentValue,
    currentDigest,
  };

  if (isVariable) {
    dep.replaceString = cleanedCurrentFrom;

    if (!dep.currentValue) {
      delete dep.currentValue;
    }

    if (!dep.currentDigest) {
      delete dep.currentDigest;
    }
  }

  return dep;
}

const quayRegex = regEx(/^quay\.io(?::[1-9][0-9]{0,4})?/i);

export function getDep(
  currentFrom: string | null | undefined,
  specifyReplaceString = true,
  registryAliases?: Record<string, string>,
): PackageDependency {
  if (!is.string(currentFrom) || is.emptyStringOrWhitespace(currentFrom)) {
    return {
      skipReason: 'invalid-value',
    };
  }

  // Resolve registry aliases first so that we don't need special casing later on:
  for (const [name, value] of Object.entries(registryAliases ?? {})) {
    const escapedName = escapeRegExp(name);
    const groups = regEx(`(?<prefix>${escapedName})/(?<depName>.+)`).exec(
      currentFrom,
    )?.groups;
    if (groups) {
      const dep = {
        ...getDep(`${value}/${groups.depName}`),
        replaceString: currentFrom,
      };
      dep.autoReplaceStringTemplate = getAutoReplaceTemplate(dep);
      return dep;
    }
  }

  const dep = splitImageParts(currentFrom);
  if (specifyReplaceString) {
    if (!dep.replaceString) {
      dep.replaceString = currentFrom;
    }
    dep.autoReplaceStringTemplate =
      '{{depName}}{{#if newValue}}:{{newValue}}{{/if}}{{#if newDigest}}@{{newDigest}}{{/if}}';
  }
  dep.datasource = DockerDatasource.id;

  // Pretty up special prefixes
  if (dep.depName) {
    const specialPrefixes = ['amd64', 'arm64', 'library'];
    for (const prefix of specialPrefixes) {
      if (dep.depName.startsWith(`${prefix}/`)) {
        dep.packageName = dep.depName;
        dep.depName = dep.depName.replace(`${prefix}/`, '');
        if (specifyReplaceString) {
          dep.autoReplaceStringTemplate =
            '{{packageName}}{{#if newValue}}:{{newValue}}{{/if}}{{#if newDigest}}@{{newDigest}}{{/if}}';
        }
      }
    }
  }

  if (dep.depName === 'ubuntu') {
    dep.versioning = ubuntuVersioning.id;
  }

  if (
    dep.depName === 'debian' &&
    debianVersioning.api.isVersion(dep.currentValue)
  ) {
    dep.versioning = debianVersioning.id;
  }

  // Don't display quay.io ports
  if (dep.depName && quayRegex.test(dep.depName)) {
    const depName = dep.depName.replace(quayRegex, 'quay.io');
    if (depName !== dep.depName) {
      dep.packageName = dep.depName;
      dep.depName = depName;
      dep.autoReplaceStringTemplate =
        '{{packageName}}{{#if newValue}}:{{newValue}}{{/if}}{{#if newDigest}}@{{newDigest}}{{/if}}';
    }
  }

  return dep;
}

export function extractPackageFile(
  content: string,
  _packageFile: string,
  config: ExtractConfig,
): PackageFileContent | null {
  const deps: PackageDependency[] = [];
  const args: Record<string, string> = {};
  const argsLines: Record<string, number[]> = {};
  const escapeChar = '\\\\';

  const lineFeed = content.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = content.split(newlineRegex);
  let currentTarget = 'base';
  for (let lineNumber = 0; lineNumber < lines.length; ) {
    const lineNumberInstrStart = lineNumber;
    let instruction = lines[lineNumber];

    const lineContinuationRegex = regEx(escapeChar + '[ \\t]*$|^[ \\t]*#', 'm');
    const targetRegex = regEx('^(?<target>\\S+?):(?:$|\\n|\\t|\\s)+', 'im');
    let lineLookahead = instruction;
    while (
      !instruction.trimStart().startsWith('#') &&
      !targetRegex.test(lineLookahead) &&
      lineContinuationRegex.test(lineLookahead)
    ) {
      lineLookahead = lines[++lineNumber] || '';
      instruction += '\n' + lineLookahead;
    }

    const targetMatch = instruction.match(targetRegex);
    if (targetMatch?.groups?.target) {
      currentTarget = targetMatch.groups.target;
    }

    //Similar to dockerfile, except ARG accepts flags and values with + should be ignored (because they indicate it's not a valid image dependency)
    const argRegex = regEx(
      '^[ \\t]*(?:ARG|LET|SET)(?:' +
        escapeChar +
        '[ \\t]*\\r?\\n| |--global|\\t|#.*?\\r?\\n)+(?<name>\\w+)[ =](?<value>[^\\s\\+]*)',
      'im',
    );
    const argMatch = argRegex.exec(instruction);
    if (argMatch?.groups?.name) {
      argsLines[argMatch.groups.name] = [lineNumberInstrStart, lineNumber];
      let argMatchValue = argMatch.groups?.value;

      if (
        argMatchValue.charAt(0) === '"' &&
        argMatchValue.charAt(argMatchValue.length - 1) === '"'
      ) {
        argMatchValue = argMatchValue.slice(1, -1);
      }

      args[argMatch.groups.name] = argMatchValue || '';
    }

    const images: string[] = [];
    const withDockerRegex = new RegExp('^[ \\t]*WITH DOCKER', 'im');

    if (withDockerRegex.test(instruction)) {
      const imageRegex = new RegExp(
        '--pull(?:\\s+|\\s*=\\s*)(?<image>[^\\s\\+]+)',
        'gim',
      );

      let match: RegExpExecArray | null;
      do {
        match = imageRegex.exec(instruction);
        if (match?.groups?.image) {
          images.push(match.groups.image);
        }
      } while (match);
    }
    const fromRegex = new RegExp(
      '^[ \\t]*FROM(?:' +
        escapeChar +
        '[ \\t]*\\r?\\n| |\\t|#.*?\\r?\\n|--platform=\\S+|--allow-privileged)+(?<image>[^\\s\\+]+)(?:(?:' +
        escapeChar +
        '[ \\t]*\\r?\\n| |\\t|#.*?\\r?\\n|--\\S+=\\S+)+)?',
      'im',
    ); // TODO #12875 complex for re2 has too many not supported groups
    const fromMatch = instruction.match(fromRegex);
    if (fromMatch?.groups?.image) {
      images.push(fromMatch.groups.image);
    }

    for (let i = 0; i < images.length; i++) {
      const lineNumberRanges: number[][] = [[lineNumberInstrStart, lineNumber]];

      let image = images[i];

      if (image.includes(variableMarker)) {
        const variables = extractVariables(image);
        for (const [fullVariable, argName] of Object.entries(variables)) {
          const resolvedArgValue = args[argName];
          if (resolvedArgValue || resolvedArgValue === '') {
            image = image.replace(fullVariable, resolvedArgValue);
            lineNumberRanges.push(argsLines[argName]);
          }
        }
      }

      if (image === 'scratch') {
        logger.debug('Skipping scratch');
      } else {
        const dep = getDep(image, true, config.registryAliases);
        processDepForAutoReplace(dep, lineNumberRanges, lines, lineFeed);
        if (!dep.depType) {
          dep.depType = currentTarget;
        }
        logger.trace(
          {
            depName: dep.depName,
            currentValue: dep.currentValue,
            currentDigest: dep.currentDigest,
            depType: dep.depType,
          },
          'Earthfile docker image',
        );
        deps.push(dep);
      }
    }
    lineNumber += 1;
  }

  if (!deps.length) {
    return null;
  }

  return { deps };
}
