// Stylistic's statement-spacing rule does not cover functions inside object
// literals. Apply the same separation to those methods and callback properties.
export default {
  meta: {
    type: 'layout',
    docs: { description: 'Separate object methods with a blank line' },
    fixable: 'whitespace',
    schema: [],
    messages: { missing: 'Add a blank line around a method with a function body.' },
  },

  create(context) {
    const source = context.sourceCode;

    function isMethod(property) {
      return property.type === 'Property' && property.value?.body?.type === 'BlockStatement';
    }

    return {
      ObjectExpression(node) {
        for (let i = 1; i < node.properties.length; i++) {
          const previous = node.properties[i - 1];
          const next = node.properties[i];
          if (!isMethod(previous) && !isMethod(next)) continue;

          // Include commas and comments: a trailing comment stays with the
          // previous method, while a leading comment stays with the next one.
          const tokens = [
            source.getLastToken(previous),
            ...source.getTokensBetween(previous, next, { includeComments: true }),
            source.getFirstToken(next),
          ];
          if (
            tokens.some(
              (token, j) => j > 0 && token.loc.start.line > tokens[j - 1].loc.end.line + 1,
            )
          )
            continue;

          let anchor = tokens[0];
          for (const token of tokens.slice(1, -1)) {
            if (token.loc.start.line !== anchor.loc.end.line) break;
            anchor = token;
          }

          const following = tokens[tokens.indexOf(anchor) + 1];
          context.report({
            node: next,
            messageId: 'missing',

            fix(fixer) {
              const newline = source.text.includes('\r\n') ? '\r\n' : '\n';
              const sameLine = following.loc.start.line === anchor.loc.end.line;
              return fixer.insertTextAfter(anchor, sameLine ? newline + newline : newline);
            },
          });
        }
      },
    };
  },
};
