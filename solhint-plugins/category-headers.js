const ruleId = "category-headers";

const ALWAYS_VALID = new Set([
  "Storage",
  "Events",
  "Errors",
  "Initialization",
  "Types",
  "Modifiers",
]);

const CONSTANTS_NAMES = new Set([
  "Constants & Immutables",
  "Constants",
  "Immutables",
]);

const FUNCTION_SECTION_NAMES = new Set([
  "Implementation",
  "Internal & Private Functions",
  "Internal Functions",
  "Private Functions",
]);

const DEFAULT_INIT_FUNCTIONS = new Set([
  "constructor",
  "supportsInterface",
  "supportsFeature",
  "initialize",
]);

const DIVIDER_RE = /^\s*\/{72}\s*$/;
const COMMENT_RE = /^\s*\/\/\s+(.+?)\s*$/;

class CategoryHeadersChecker {
  ruleId = ruleId;
  meta = { fixable: true };

  constructor(reporter, config, inputSrc) {
    this.reporter = reporter;
    this.inputSrc = inputSrc;
    this._lines = null;
    this._categoryBlocks = [];
    this._contractRanges = [];

    const userConfig =
      config?.getObject(`contracts-v2/${ruleId}`) ||
      config?.getObject(ruleId) ||
      {};
    this.minCategories = userConfig.minCategories ?? 2;

    const userInitFns = userConfig.initializationFunctions;
    if (Array.isArray(userInitFns) && userInitFns.length > 0) {
      this.initializationFunctions = new Set(userInitFns);
    } else {
      this.initializationFunctions = DEFAULT_INIT_FUNCTIONS;
    }
  }

  _initLines() {
    if (this._lines) return;
    this._lines = [];
    const src = this.inputSrc;
    let start = 0;
    for (let i = 0; i <= src.length; i++) {
      if (i === src.length || src[i] === "\n") {
        this._lines.push({
          start,
          end: i,
          content: src.slice(start, i),
        });
        start = i + 1;
      }
    }
  }

  _getLineIndex(offset) {
    let lo = 0;
    let hi = this._lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this._lines[mid].start <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  _scanCategoryHeaders() {
    this._categoryBlocks = [];
    const lines = this._lines;
    for (let i = 0; i < lines.length - 2; i++) {
      if (!DIVIDER_RE.test(lines[i].content)) continue;
      const nameMatch = COMMENT_RE.exec(lines[i + 1].content);
      if (!nameMatch) continue;
      if (!DIVIDER_RE.test(lines[i + 2].content)) continue;

      const indent = lines[i].content.match(/^(\s*)/)[1];
      const nameLineStart = lines[i + 1].start;
      const nameLineEnd = lines[i + 1].end;

      this._categoryBlocks.push({
        name: nameMatch[1],
        lineIdx: i + 1,
        indent,
        startOffset: lines[i].start,
        endOffset: lines[i + 2].end,
        nameLineStart,
        nameLineEnd,
        // blockWithNewline includes the trailing \n so deleting a whole block is clean
        blockWithNewlineEnd: lines[i + 2].end + 1,
      });
    }
  }

  _blocksInRange(start, end) {
    return this._categoryBlocks.filter(
      (b) => b.startOffset >= start && b.endOffset <= end,
    );
  }

  _nearestCategoryBefore(offset, contractStart, contractEnd) {
    const blocks = this._blocksInRange(contractStart, contractEnd);
    let nearest = null;
    for (const b of blocks) {
      if (b.startOffset < offset) {
        nearest = b;
      }
    }
    return nearest;
  }

  _isInitFunction(name) {
    if (this.initializationFunctions.has(name)) return true;
    if (name.startsWith("_init") || name.startsWith("__init")) return true;
    return false;
  }

  _findEnclosingContract(offset) {
    for (const cr of this._contractRanges) {
      if (offset >= cr.start && offset <= cr.end) {
        return cr;
      }
    }
    return null;
  }

  _expectedCategory(node, fnName) {
    if (this._isInitFunction(fnName)) {
      return "Initialization";
    }

    const visibility = node.visibility || "default";

    if (
      visibility === "public" ||
      visibility === "external" ||
      visibility === "default"
    ) {
      return "Implementation";
    }
    if (visibility === "internal") {
      return "Internal Functions";
    }
    if (visibility === "private") {
      return "Private Functions";
    }

    return null;
  }

  // Build the replacement text for the "// Name" portion of a header line
  _makeNameLine(indent, newName) {
    return `${indent}// ${newName}`;
  }

  // Report a conflict where firstBlock should be renamed and secondBlock deleted.
  // Each block gets its own reporter.error call with its own fixer.
  _reportMergeConflict(node, firstBlock, secondBlock, combinedName, message) {
    // Fix for firstBlock: rename its label line to combinedName
    // Range end is inclusive in solhint's applyFixes
    this.reporter.error(node, ruleId, message, (fixer) =>
      fixer.replaceTextRange(
        [firstBlock.nameLineStart, firstBlock.nameLineEnd - 1],
        this._makeNameLine(firstBlock.indent, combinedName),
      ),
    );

    // Fix for secondBlock: delete the entire block (including trailing newline)
    // Range end is inclusive in solhint's applyFixes
    const deleteEnd = Math.min(
      secondBlock.blockWithNewlineEnd,
      this.inputSrc.length,
    ) - 1;
    this.reporter.error(node, ruleId, message, (fixer) =>
      fixer.replaceTextRange([secondBlock.startOffset, deleteEnd], ""),
    );
  }

  SourceUnit(node) {
    this._initLines();
    this._scanCategoryHeaders();
    this._contractRanges = [];

    const collect = (nodes) => {
      if (!nodes) return;
      for (const child of nodes) {
        if (child && child.type === "ContractDefinition" && child.range) {
          this._contractRanges.push({
            start: child.range[0],
            end: child.range[1],
            contractKind: child.kind,
          });
        }
      }
    };
    collect(node.children);
  }

  ContractDefinition(node) {
    if (!node.range) return;
    const [contractStart, contractEnd] = node.range;
    const blocks = this._blocksInRange(contractStart, contractEnd);

    // Minimum category count check (no fix possible)
    if (blocks.length < this.minCategories) {
      this.reporter.error(
        node,
        ruleId,
        `Contract '${node.name}' has ${blocks.length} category header(s), minimum is ${this.minCategories}`,
      );
    }

    // Validate each block's name (no fix for unknown names)
    for (const block of blocks) {
      const { name } = block;
      if (
        !ALWAYS_VALID.has(name) &&
        !CONSTANTS_NAMES.has(name) &&
        !FUNCTION_SECTION_NAMES.has(name)
      ) {
        this.reporter.error(node, ruleId, `Unknown category name '${name}'`);
      }
    }

    // Constants conflict checks
    const hasConstantsAndImmutables = blocks.some(
      (b) => b.name === "Constants & Immutables",
    );
    const constantsBlock = blocks.find((b) => b.name === "Constants");
    const immutablesBlock = blocks.find((b) => b.name === "Immutables");

    if (constantsBlock && immutablesBlock) {
      // Both separate — rename first to combined, delete second
      const [first, second] =
        constantsBlock.startOffset < immutablesBlock.startOffset
          ? [constantsBlock, immutablesBlock]
          : [immutablesBlock, constantsBlock];
      this._reportMergeConflict(
        node,
        first,
        second,
        "Constants & Immutables",
        `Use 'Constants & Immutables' instead of separate 'Constants' and 'Immutables' headers`,
      );
    } else if (hasConstantsAndImmutables && (constantsBlock || immutablesBlock)) {
      // Combined already exists — delete the stray individual block
      const stray = constantsBlock || immutablesBlock;
      const deleteEnd = Math.min(
        stray.blockWithNewlineEnd,
        this.inputSrc.length,
      ) - 1;
      this.reporter.error(
        node,
        ruleId,
        `Use 'Constants & Immutables' instead of separate 'Constants' and 'Immutables' headers`,
        (fixer) =>
          fixer.replaceTextRange([stray.startOffset, deleteEnd], ""),
      );
    }

    // Library: 'Internal Functions' alongside 'Implementation' — rename to 'Implementation'
    if (node.kind === "library") {
      const hasImplementation = blocks.some((b) => b.name === "Implementation");
      const internalFnsBlock = blocks.find((b) => b.name === "Internal Functions");
      if (hasImplementation && internalFnsBlock) {
        this.reporter.error(
          node,
          ruleId,
          `Use 'Implementation' for library functions (not 'Internal Functions')`,
          (fixer) =>
            fixer.replaceTextRange(
              [internalFnsBlock.nameLineStart, internalFnsBlock.nameLineEnd - 1],
              this._makeNameLine(internalFnsBlock.indent, "Implementation"),
            ),
        );
      }
    }

    // Non-library: 'Internal Functions' + 'Private Functions' conflict
    if (node.kind !== "library") {
      const hasInternalAndPrivate = blocks.some(
        (b) => b.name === "Internal & Private Functions",
      );
      const internalFnsBlock = blocks.find((b) => b.name === "Internal Functions");
      const privateFnsBlock = blocks.find((b) => b.name === "Private Functions");

      if (internalFnsBlock && privateFnsBlock) {
        const [first, second] =
          internalFnsBlock.startOffset < privateFnsBlock.startOffset
            ? [internalFnsBlock, privateFnsBlock]
            : [privateFnsBlock, internalFnsBlock];
        this._reportMergeConflict(
          node,
          first,
          second,
          "Internal & Private Functions",
          `Use 'Internal & Private Functions' instead of separate 'Internal Functions' and 'Private Functions' headers`,
        );
      } else if (
        hasInternalAndPrivate &&
        (internalFnsBlock || privateFnsBlock)
      ) {
        const stray = internalFnsBlock || privateFnsBlock;
        const deleteEnd = Math.min(
          stray.blockWithNewlineEnd,
          this.inputSrc.length,
        ) - 1;
        this.reporter.error(
          node,
          ruleId,
          `Use 'Internal & Private Functions' instead of separate 'Internal Functions' and 'Private Functions' headers`,
          (fixer) =>
            fixer.replaceTextRange([stray.startOffset, deleteEnd], ""),
        );
      }
    }
  }

  FunctionDefinition(node) {
    if (!node.range) return;

    const fnName =
      node.isConstructor || node.name === null ? "constructor" : node.name;
    const expectedCategory = this._expectedCategory(node, fnName);
    if (!expectedCategory) return;

    const contractInfo = this._findEnclosingContract(node.range[0]);
    if (!contractInfo) return;

    const { start: contractStart, end: contractEnd, contractKind } = contractInfo;

    const nearestBlock = this._nearestCategoryBefore(
      node.range[0],
      contractStart,
      contractEnd,
    );

    const actualCategory = nearestBlock ? nearestBlock.name : null;

    let resolvedExpected = expectedCategory;
    if (contractKind === "library" && resolvedExpected === "Internal Functions") {
      resolvedExpected = "Implementation";
    }

    // In non-library contracts, internal/private functions may be under a combined header
    const isAcceptable =
      actualCategory === resolvedExpected ||
      (contractKind !== "library" &&
        actualCategory === "Internal & Private Functions" &&
        (resolvedExpected === "Internal Functions" ||
          resolvedExpected === "Private Functions"));

    if (!isAcceptable) {
      // No automated fix for misplaced functions (would require moving code)
      this.reporter.error(
        node,
        ruleId,
        `Function '${fnName}' should be under the '${resolvedExpected}' category`,
      );
    }
  }
}

module.exports = CategoryHeadersChecker;
