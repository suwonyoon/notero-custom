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
import { getAnnotations, getNotionColor } from './annotations';

export async function convertHtmlToBlocks(
  html: string,
  options: { isAnnotation?: boolean } = {},
): Promise<BlockObjectRequest[]> {
  const { isAnnotation = false } = options;
  
  logger.debug("=== CONVERTING HTML TO BLOCKS ===");
  logger.debug("Is Annotation (from options): " + isAnnotation);
  logger.debug("HTML: " + html);

  const doc = parseHTML(html);
  const container = findContainer(doc);
  
  if (!container) {
    logger.debug("No container found, returning empty annotation");
    return createEmptyAnnotation();
  }

  // Find all paragraph elements
  const paragraphs = container.getElementsByTagName('p');
  logger.debug("Found paragraphs count: " + paragraphs.length);
  
  if (paragraphs.length === 0) {
    logger.debug("No paragraphs found, returning empty annotation");
    return createEmptyAnnotation();
  }

  // Process each paragraph and flatten the results
  const results = await Promise.all(
    Array.from(paragraphs)
      .map(async (element) => {
        const parsedNode = parseNode(element);
        if (!parsedNode) {
          return;
        }

        const result = await convertNode(parsedNode, { isAnnotation });
        if (isAnnotation && 
            result?.type === 'paragraph' && 
            result.paragraph.children) {
          return result.paragraph.children;
        }
        return result;
      })
  );

  return results.filter(Boolean).flat();
}

function createEmptyAnnotation(): BlockObjectRequest[] {
  return [
    {
      type: 'callout',
      callout: {
        rich_text: [{
          type: 'text',
          text: { content: 'Empty' }
        }],
        color: 'yellow_background'
      }
    },
    {
      type: 'paragraph',
      paragraph: {
        rich_text: [{
          type: 'text',
          text: { content: 'No annotation provided' }
        }]
      }
    },
    {
      type: 'divider',
      divider: {}
    }
  ];
}

async function convertNode(
  node: ParsedNode,
  options: RichTextOptions & { isAnnotation?: boolean },
): Promise<BlockObjectRequest | undefined> {
  switch (node.type) {
    case 'block':
      const result = await convertBlockElement(node, options);
      return result.block;
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

async function convertBlockElement(
  { annotations, blockType, color, element }: BlockElement,
  options: RichTextOptions & { isAnnotation?: boolean },
): Promise<BlockResult> {
  const { isAnnotation = false } = options;
  
  logger.debug(`Converting block element: ${element.tagName}`);
  
  if (isAnnotation && element.tagName === 'P') {
    logger.debug("Processing annotation paragraph");
    const highlightSpan = element.querySelector('.highlight');
    const image = element.querySelector('img');
    
    logger.debug(`Found highlight: ${!!highlightSpan}, image: ${!!image}`);
    
    if (highlightSpan || image) {
      let blocks: ChildBlock[] = [];
      
      if (image) {
        try {
          const annotationData = JSON.parse(decodeURIComponent(image.getAttribute('data-annotation') || '{}'));
          const annotationKey = annotationData.annotationKey;
          const color = annotationData.color;
          logger.debug('Annotation data:', { annotationKey, color });

          // Extract comment (text after citation)
          const citationSpan = element.querySelector('.citation');
          let comment = '';
          if (citationSpan) {
            const nextSibling = citationSpan.nextSibling;
            if (nextSibling) {
              comment = nextSibling.textContent?.trim() || '';
            }
          }
          logger.debug('Extracted comment:', comment);

          // Construct image path directly
          const imagePath = '/Users/suwonyoon/Library/Application Support/Zotero/Profiles/o576o2ld.dev/zotero/cache/library/' + 
                          `${annotationKey}.png`;
          logger.debug('Image path:', imagePath);

          // Upload to Imgur
          const imgurUrl = await uploadToImgur(imagePath);
          logger.debug('Imgur URL:', imgurUrl);

          // Convert hex color to Notion color
          const notionColor = getNotionColorFromHex(color);

          blocks = [
            {
              type: 'callout',
              callout: {
                rich_text: [{
                  type: 'text',
                  text: { content: comment }
                }],
                color: notionColor || 'yellow_background',
                children: [
                  {
                    type: 'image',
                    image: {
                      type: 'external',
                      external: {
                        url: imgurUrl
                      }
                    }
                  }
                ]
              }
            },
            {
              type: 'divider',
              divider: {}
            }
          ];
        } catch (error) {
          logger.error('Error processing image annotation:', error);
          blocks = createFillerBlocks();
        }
      } else if (highlightSpan) {
        // Get the inner span with the background color
        const colorSpan = highlightSpan.querySelector('span');
        const notionColor = getNotionColor(colorSpan || highlightSpan);
        logger.debug('Converted Notion color:', notionColor);
        
        const rawText = colorSpan?.textContent || highlightSpan.textContent || '';
        const highlightedText = rawText.slice(1, -1).trim();
        
        logger.debug("Highlight text:", {
          raw: rawText,
          processed: highlightedText,
          notionColor
        });
        
        // Get the remaining text after the citation
        const citationSpan = element.querySelector('.citation');
        let remainingText = '';
        if (citationSpan) {
          const nextSibling = citationSpan.nextSibling;
          if (nextSibling) {
            remainingText = nextSibling.textContent || '';
          }
        }
        
        logger.debug("Citation and remaining text:", {
          citation: citationSpan?.textContent,
          remaining: remainingText
        });
        
        // Split into comment and tags
        const [comment, ...tagParts] = remainingText.trim().split(/#/);
        
        // Format tags with code annotation
        const formattedTags = tagParts.map(tag => ({
          type: 'text',
          text: { content: '#' + tag.trim() },
          annotations: { code: true }
        }));

        blocks = [
          {
            type: 'callout',
            callout: {
              rich_text: [{
                type: 'text',
                text: { content: highlightedText }
              }],
              color: notionColor || 'yellow_background'
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
        ];
      }

      logger.debug("Created blocks count:", blocks.length);
      return blockResult({
        type: 'paragraph',
        paragraph: {
          rich_text: [],
          children: blocks
        }
      });
    }
  }
  
  logger.debug("Processing as regular block");
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

// Updated color mapping function
function getNotionColorFromHex(hexColor: string): string {
  // Simple mapping of hex colors to Notion colors
  const colorMap: Record<string, string> = {
    '#ffd400': 'yellow_background',
    '#ff6666': 'red_background',
    '#ffb437': 'orange_background',
    '#5ff036': 'green_background',
    '#50c8e5': 'blue_background',
    '#a28ae5': 'purple_background',
    '#e56eee': 'pink_background',
    '#aaaaaa': 'gray_background',
    // Add RGB format support
    'rgb(255, 212, 0)': 'yellow_background',
    'rgb(255, 102, 102)': 'red_background',
    'rgb(255, 180, 55)': 'orange_background',
    'rgb(95, 240, 54)': 'green_background',
    'rgb(80, 200, 229)': 'blue_background',
    'rgb(162, 138, 229)': 'purple_background',
    'rgb(229, 110, 238)': 'pink_background',
    'rgb(170, 170, 170)': 'gray_background'
  };

  // Normalize the color value
  const normalizedColor = hexColor.toLowerCase().trim();
  return colorMap[normalizedColor] || 'yellow_background';
}

function createFillerBlocks(): ChildBlock[] {
  return [
    {
      type: 'callout',
      callout: {
        rich_text: [{
          type: 'text',
          text: { content: 'Filler' }
        }],
        color: 'yellow_background'
      }
    },
    {
      type: 'paragraph',
      paragraph: {
        rich_text: [{
          type: 'text',
          text: { content: 'Filler' }
        }]
      }
    },
    {
      type: 'divider',
      divider: {}
    }
  ];
}
