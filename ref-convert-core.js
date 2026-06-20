#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { ConversionError } = require('../formats/parser');
const {
  usage,
  parseArgs,
  makeConversionArgs,
} = require('../common/args');

const {
  convertPartitionedPlyTo3DTiles,
} = require('../pipeline/partitioned-ply');
const { runSelfTestConversion } = require('./self-test');
const { defaultLogger, resolveLogger } = require('../common/logger');

async function openTilesetInspector(outputDir, logger = defaultLogger) {
  const tilesetPath = path.join(outputDir, 'tileset.json');
  const { runInspector } = require('3dtiles-inspector');
  resolveLogger(logger).info(`opening inspector: ${tilesetPath}`);
  await runInspector(tilesetPath);
}

async function convertPlyTo3DTiles(inputPath, outputDir, options = {}) {
  const args = makeConversionArgs(inputPath, outputDir, options, {
    requireInput: true,
  });
  const inPath = path.resolve(args.input);
  const outPath = path.resolve(args.output);
  const result = await convertPartitionedPlyTo3DTiles(
    inPath,
    outPath,
    args,
  );
  if (args.openInspector) {
    await openTilesetInspector(outPath, resolveLogger(args));
  }
  return {
    inputPath: inPath,
    outputDir: outPath,
    splatCount: result.splatCount,
    shDegree: result.shDegree,
    args,
  };
}

async function main(argv) {
  let logger = defaultLogger;
  try {
    const args = parseArgs(argv);
    logger = resolveLogger(args);
    if (args.help) {
      logger.line(usage());
      return 0;
    }

    const outDir = path.resolve(args.output);

    if (args.selfTest) {
      await runSelfTestConversion(outDir, args, {
        convertPartitionedPlyTo3DTiles,
        openTilesetInspector,
      });
      return 0;
    }

    if (!args.input) {
      throw new ConversionError(
        'Please provide an input PLY file, or use --self-test.',
      );
    }
    if (!fs.existsSync(args.input)) {
      throw new ConversionError(`Input file does not exist: ${args.input}`);
    }

    const inPath = path.resolve(args.input);
    logger.info(`reading PLY: ${inPath}`);
    const result = await convertPartitionedPlyTo3DTiles(
      inPath,
      outDir,
      args,
    );
    logger.info(
      `parsed PLY | splats=${result.splatCount} | sh_degree=${result.shDegree}`,
    );
    logger.ok(`output completed: ${outDir}`);
    if (args.openInspector) {
      await openTilesetInspector(outDir, logger);
    }
    return 0;
  } catch (err) {
    if (err instanceof ConversionError) {
      logger.error(`Conversion failed: ${err.message}`);
    } else if (err != null) {
      logger.error(err.message || String(err));
    }
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      if (err instanceof ConversionError) {
        defaultLogger.error(`Conversion failed: ${err.message}`);
      } else if (err != null) {
        defaultLogger.error(err.message || String(err));
      }
      process.exit(2);
    });
}

module.exports = {
  main,
  convertPlyTo3DTiles,
};
