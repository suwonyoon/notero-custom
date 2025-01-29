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
import { uploadToImgur } from '../../utils/imgur';

async function convertNode(
  node: ParsedNode,
  options: RichTextOptions & { isAnnotation?: boolean },
): Promise<BlockObjectRequest | BlockObjectRequest[] | undefined> {
  switch (node.type) {
    case 'block':
      const blockResult = await convertBlockElement(node, options);
      if ('results' in blockResult) {
        return blockResult.results.map(r => r.block);
      }
      return blockResult.block;
    case 'list':
      const listResult = convertListElement(node, options);
      return listResult.results.map(r => r.block);
    default:
      return;
  }
}

export async function convertHtmlToBlocks(
  html: string,
  options: { isAnnotation?: boolean } = {},
): Promise<BlockObjectRequest[]> {
  const { isAnnotation = false } = options;
  
  logger.debug("=== CONVERTING HTML TO BLOCKS ===");
  logger.debug("Is Annotation (from options): " + isAnnotation);
  logger.debug("HTML: " + html);

  try {
    // Create a temporary div to parse HTML and get text content
    const doc = parseHTML(html);
    const text = doc.body?.textContent || html;

    const blocks = [{
      type: 'paragraph',
      paragraph: {
        rich_text: [{
          type: 'text',
          text: { content: text.trim() }
        }]
      }
    }];

    logger.debug("Created blocks:", blocks);
    return blocks;
  } catch (error) {
    logger.error("Error converting HTML to blocks:", error);
    return [];
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

async function convertBlockElement(
  { annotations, blockType, color, element }: BlockElement,
  options: RichTextOptions & { isAnnotation?: boolean },
): Promise<BlockResult> {
  const { isAnnotation = false } = options;
  
  if (isAnnotation && element.tagName === 'P') {
    const blocks: BlockObjectRequest[] = [];
    
    try {
      // Process image annotation if present
      const imgElement = element.querySelector('img[data-annotation]');
      if (imgElement) {
        try {
          await Zotero.uiReadyPromise;
          if (!Zotero.Notero) {
            throw new Error('Notero not initialized');
          }

          const annotationData = JSON.parse(decodeURIComponent(imgElement.getAttribute('data-annotation') || '{}'));
          const annotationKey = annotationData.annotationKey;
          
          const localFilePath = `/Users/suwonyoon/Library/Application Support/Zotero/Profiles/o576o2ld.dev/zotero/cache/library/${annotationKey}.png`;
          
          logger.debug('Uploading image to Imgur...');
          const imgurUrl = await uploadToImgur(localFilePath);
          logger.debug('Got Imgur URL:', imgurUrl);
          
          blocks.push({
            type: 'image',
            image: {
              type: 'external',
              external: {
                url: imgurUrl
              }
            }
          });
        } catch (error) {
          logger.error('Failed to process image annotation:', error);
          blocks.push({
            type: 'paragraph',
            paragraph: {
              rich_text: [{
                type: 'text',
                text: { content: `[Image annotation error: ${error.message}]` }
              }]
            }
          });
        }
      }
      
      // Process text annotation if present
      const highlightSpan = element.querySelector('.highlight');
      if (highlightSpan) {
        try {
          const innerSpan = highlightSpan.querySelector('span');
          const text = innerSpan?.textContent || highlightSpan.textContent || '';
          const highlightedText = text.trim();
          
          blocks.push({
            type: 'quote',
            quote: {
              rich_text: [{
                type: 'text',
                text: { content: highlightedText }
              }],
              color: 'yellow_background'
            }
          });
          
          // Get comment if any
          const citationSpan = element.querySelector('.citation');
          if (citationSpan) {
            const nextSibling = citationSpan.nextSibling;
            if (nextSibling && nextSibling.textContent) {
              blocks.push({
                type: 'paragraph',
                paragraph: {
                  rich_text: [{
                    type: 'text',
                    text: { content: nextSibling.textContent.trim() }
                  }]
                }
              });
            }
          }
        } catch (error) {
          logger.error('Failed to process text annotation:', error);
          blocks.push({
            type: 'paragraph',
            paragraph: {
              rich_text: [{
                type: 'text',
                text: { content: `[Text annotation error: ${error.message}]` }
              }]
            }
          });
        }
      }
      
      // Return blocks directly instead of nesting them
      if (blocks.length === 1) {
        return blockResult(blocks[0]);
      } else if (blocks.length > 1) {
        // If we have multiple blocks, return them as a list
        return {
          type: 'list',
          results: blocks.map(block => blockResult(block))
        };
      }
    } catch (error) {
      logger.error('Failed to process annotation block:', error);
      return blockResult({
        type: 'paragraph',
        paragraph: {
          rich_text: [{
            type: 'text',
            text: { content: `[Annotation processing error: ${error.message}]` }
          }]
        }
      });
    }
  }
  
  // Default handling for non-annotation blocks
  return blockResult({
    type: blockType,
    [blockType]: {
      rich_text: [],
      ...(color && { color })
    }
  });
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
