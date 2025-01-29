import { keyValue } from '../../utils';
import {
  ChildBlock,
  ParagraphBlock,
  RichText,
  RichTextOptions,
  isBlockType,
  BlockObjectRequest,
} from '../notion-types';
import { buildRichText } from '../notion-utils';

import {
  BlockResult,
  ContentResult,
  ListResult,
  RichTextResult,
  blockResult,
  isBlockResult,
  isListResult,
  isRichTextResult,
  listResult,
  richTextResult,
} from './content-result';
import { getRootElement, parseHTML, findContainer } from './dom-utils';
import {
  BlockElement,
  ListElement,
  ParentElement,
  ParsedNode,
  parseNode,
} from './parse-node';
import { logger } from '../../utils';

export function convertHtmlToBlocks(
  html: string,
  options: { isAnnotation?: boolean } = {},
): BlockObjectRequest[] {
  const { isAnnotation = false } = options;
  
  logger.debug("=== CONVERTING HTML TO BLOCKS ===");
  logger.debug("Is Annotation (from options): " + isAnnotation);
  logger.debug("HTML: " + html);

  const doc = parseHTML(html);
  const container = findContainer(doc);
  
  if (!container) {
    return [];
  }

  return Array.from(container.children)
    .map((element) => {
      const parsedNode = parseNode(element);
      if (!parsedNode) {
        return;
      }

      // Pass isAnnotation to all conversion functions
      return convertNode(parsedNode, { isAnnotation });
    })
    .filter(Boolean);
}

function convertNode(
  node: ParsedNode,
  options: RichTextOptions & { isAnnotation?: boolean },
): BlockObjectRequest | undefined {
  switch (node.type) {
    case 'block':
      // Pass isAnnotation to convertBlockElement
      return convertBlockElement(node, options).block;
    case 'list':
      return convertListElement(node, options).block;
    default:
      return;
  }
}

function convertParentElement(
  { annotations, blockType, color, element }: ParentElement,
  options: RichTextOptions,
): BlockResult {
  const updatedOptions = {
    ...options,
    annotations: {
      ...options.annotations,
      ...annotations,
    },
  };

  let rich_text: RichText = [];
  let children: ChildBlock[] | undefined;

  convertChildNodes(element, updatedOptions).forEach((result) => {
    let childBlock: ChildBlock;

    if (isRichTextResult(result)) {
      const trimmedRichText = trimRichText(result.richText);
      if (!trimmedRichText.length) return;

      if (!children) {
        rich_text = [...rich_text, ...trimmedRichText];
        return;
      }
      childBlock = paragraphBlock(trimmedRichText);
    } else {
      childBlock = result.block;
    }

    if (
      !children &&
      !rich_text.length &&
      isBlockType('paragraph', childBlock)
    ) {
      rich_text = childBlock.paragraph.rich_text;
      children = childBlock.paragraph.children;
      return;
    }

    children = [...(children || []), childBlock];
  });

  return blockResult(
    keyValue(blockType, {
      rich_text,
      ...(children && { children }),
      ...(color && { color }),
    }),
  );
}

function convertBlockElement(
  { annotations, blockType, color, element }: BlockElement,
  options: RichTextOptions & { isAnnotation?: boolean },
): BlockResult {
  const { isAnnotation = false } = options;
  
  // Check if this is an annotation paragraph
  if (isAnnotation && element.tagName === 'P') {
    const highlightSpan = element.querySelector('.highlight');
    
    if (highlightSpan) {
      // Get the inner span's text content and remove first and last character
      const innerSpan = highlightSpan.querySelector('span');
      const rawText = innerSpan?.textContent || highlightSpan.textContent || '';
      const highlightedText = rawText.slice(1, -1).trim();
      
      logger.debug("Original text: " + rawText);
      logger.debug("Processed text: " + highlightedText);
      
      // Get the remaining text after the citation
      const citationSpan = element.querySelector('.citation');
      let remainingText = '';
      if (citationSpan) {
        const nextSibling = citationSpan.nextSibling;
        if (nextSibling) {
          remainingText = nextSibling.textContent || '';
        }
      }
      
      // Split into comment and tags
      const [comment, ...tagParts] = remainingText.trim().split(/#/);
      
      // Format tags with code annotation
      const formattedTags = tagParts.map(tag => ({
        type: 'text',
        text: { content: '#' + tag.trim() },
        annotations: { code: true }
      }));

      // Create blocks array
      return blockResult({
        type: 'paragraph',
        paragraph: {
          rich_text: [], // Empty rich_text array for the parent
          children: [
            {
              type: 'callout',
              callout: {
                rich_text: [{
                  type: 'text',
                  text: { content: highlightedText }
                }],
                color: 'yellow_background'
              }
            },
            {
              type: 'paragraph',
              paragraph: {
                rich_text: [
                  {
                    type: 'text',
                    text: { content: comment.trim() + '\n' }
                  },
                  ...formattedTags.flatMap((tag, index) => [
                    tag,
                    { type: 'text', text: { content: ' ' } }
                  ]).slice(0, -1)
                ]
              }
            },
            {
              type: 'divider',
              divider: {}
            }
          ]
        }
      });
    }
  }

  // Default handling for non-annotation blocks
  const updatedOptions = {
    ...options,
    annotations: {
      ...options.annotations,
      ...annotations,
    },
    preserveWhitespace: blockType === 'code'
  };

  let rich_text = convertRichTextChildNodes(element, updatedOptions);
  if (!updatedOptions.preserveWhitespace) {
    rich_text = trimRichText(rich_text);
  }

  return blockResult(
    keyValue(blockType, {
      rich_text,
      ...(color && { color }),
    }),
  );
}

function convertListElement(
  node: ListElement,
  options: RichTextOptions,
): ListResult {
  return listResult(
    Array.from(node.element.children)
      .map((element) => {
        const parsedChild = parseNode(element);

        if (
          parsedChild?.type === 'block' &&
          parsedChild.supportsChildren &&
          parsedChild.blockType.endsWith('list_item')
        ) {
          return convertParentElement(parsedChild, options);
        }
      })
      .filter(Boolean),
  );
}

function convertChildNodes(
  node: Node,
  options: RichTextOptions,
): (BlockResult | RichTextResult)[] {
  return Array.from(node.childNodes).reduce<(BlockResult | RichTextResult)[]>(
    (results, childNode) => {
      const result = convertNode(childNode, options);

      if (!result) return results;

      if (isBlockResult(result)) return [...results, result];

      if (isListResult(result)) return [...results, ...result.results];

      const prevResult = results[results.length - 1];

      if (prevResult && isRichTextResult(prevResult)) {
        const concatResult = richTextResult([
          ...prevResult.richText,
          ...result.richText,
        ]);
        return [...results.slice(0, -1), concatResult];
      }

      return [...results, result];
    },
    [],
  );
}

function convertRichTextChildNodes(
  node: Node,
  options: RichTextOptions,
): RichText {
  return Array.from(node.childNodes).reduce<RichText>(
    (combinedRichText, childNode) => {
      const parsedNode = parseNode(childNode);

      if (!parsedNode) return combinedRichText;

      return [...combinedRichText, ...convertRichTextNode(parsedNode, options)];
    },
    [],
  );
}

function convertRichTextNode(
  node: ParsedNode,
  options: RichTextOptions,
): RichText {
  if (node.type === 'text') {
    return buildRichText(node.textContent, options);
  }

  if (node.type === 'br') {
    return buildRichText('\n', { ...options, preserveWhitespace: true });
  }

  if (node.type === 'inline_math') {
    return [{ equation: { expression: node.expression } }];
  }

  const updatedOptions = { ...options };

  if (node.type === 'rich_text') {
    updatedOptions.annotations = {
      ...options.annotations,
      ...node.annotations,
    };
    if (node.link) {
      updatedOptions.link = node.link;
    }
  }

  return convertRichTextChildNodes(node.element, updatedOptions);
}

function paragraphBlock(richText: RichText): ParagraphBlock {
  return { paragraph: { rich_text: richText } };
}

function trimRichText(richText: RichText): RichText {
  function updateContent(
    index: number,
    updater: (content: string) => string,
  ): RichText {
    const richTextPart = richText[index];

    if (!richTextPart) return [];

    if (!('text' in richTextPart)) return [richTextPart];

    const content = updater(richTextPart.text.content);

    if (!content) return [];

    return [
      {
        ...richTextPart,
        text: { ...richTextPart.text, content },
      },
    ];
  }

  if (richText.length === 0) return richText;

  if (richText.length === 1) {
    return updateContent(0, (content) => content.trim());
  }

  const first = updateContent(0, (content) => content.trimStart());
  const middle = richText.slice(1, -1);
  const last = updateContent(richText.length - 1, (content) =>
    content.trimEnd(),
  );

  return [...first, ...middle, ...last];
}
