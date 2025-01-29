import type { Annotations, BlockType, Color, TextLink } from '../notion-types';

import { getAnnotations } from './annotations';
import { isHTMLElement, isTextNode } from './dom-utils';

const BLOCKS_SUPPORTING_CHILDREN = new Set([
  'bulleted_list_item',
  'numbered_list_item',
  'paragraph',
  'quote',
]) satisfies Set<BlockType>;

type ParentBlockType = Parameters<
  (typeof BLOCKS_SUPPORTING_CHILDREN)['add']
>[0];

export type BlockElement = {
  annotations: Annotations;
  color: Color;
  element: HTMLElement;
  type: 'block';
} & (
  | {
      blockType: 'code' | 'heading_1' | 'heading_2' | 'heading_3';
      supportsChildren: false;
    }
  | {
      blockType: ParentBlockType;
      supportsChildren: true;
    }
);

export type ParentElement = Extract<BlockElement, { supportsChildren: true }>;

type BRElement = {
  type: 'br';
};

type InlineMathElement = {
  element: HTMLElement;
  expression: string;
  type: 'inline_math';
};

export type ListElement = {
  element: HTMLElement;
  type: 'list';
};

type MathBlockElement = {
  blockType: 'equation';
  element: HTMLElement;
  expression: string;
  type: 'math_block';
};

type RichTextElement = {
  annotations: Annotations;
  element: HTMLElement;
  link?: TextLink;
  type: 'rich_text';
};

type TextNode = {
  textContent: Node['textContent'];
  type: 'text';
};

export type ParsedNode =
  | BlockElement
  | BRElement
  | InlineMathElement
  | ListElement
  | MathBlockElement
  | RichTextElement
  | TextNode;

function doesBlockSupportChildren(
  blockType: BlockElement['blockType'],
): blockType is ParentBlockType {
  return BLOCKS_SUPPORTING_CHILDREN.has(blockType);
}

function getMathExpression(element: HTMLElement): string | null {
  const { classList, textContent } = element;

  const isMathElement = textContent && classList.contains('math');

  if (!isMathElement) return null;

  const matches = /^\${1,2}((?:.|\n)+?)\${1,2}$/.exec(textContent);
  const expression = matches?.[1];

  return expression || null;
}

function parseAnchorElement(element: HTMLAnchorElement): RichTextElement {
  const isHttpURL = /^https?:\/\/.+/.test(element.href);

  return {
    ...parseRichTextElement(element),
    ...(isHttpURL && { link: { url: element.href } }),
  };
}

function parseBlockElement(
  element: HTMLElement,
  blockType: BlockElement['blockType'],
): BlockElement {
  const { color, ...annotations } = getAnnotations(element);

  return {
    ...(doesBlockSupportChildren(blockType)
      ? { blockType, supportsChildren: true }
      : { blockType, supportsChildren: false }),
    annotations,
    color,
    element,
    type: 'block',
  };
}

function parseListItemElement(element: HTMLElement): BlockElement {
  if (element.parentElement?.tagName === 'OL')
    return parseBlockElement(element, 'numbered_list_item');

  if (element.parentElement?.tagName === 'UL')
    return parseBlockElement(element, 'bulleted_list_item');

  return parseBlockElement(element, 'paragraph');
}

function parsePreElement(
  element: HTMLElement,
): BlockElement | MathBlockElement {
  const expression = getMathExpression(element);

  if (expression) {
    return { blockType: 'equation', element, expression, type: 'math_block' };
  }

  return parseBlockElement(element, 'code');
}

function parseSpanElement(
  element: HTMLElement,
): InlineMathElement | RichTextElement {
  const expression = getMathExpression(element);

  if (expression) {
    return { element, expression, type: 'inline_math' };
  }

  return parseRichTextElement(element);
}

function parseRichTextElement(element: HTMLElement): RichTextElement {
  return {
    annotations: getAnnotations(element),
    element,
    type: 'rich_text',
  };
}

function parseTextNode(node: Node): TextNode | undefined {
  const { textContent } = node;
  if (!textContent?.trim()) return;
  return { type: 'text', textContent };
}

export function parseNode(node: any): ParsedNode | undefined {
  if (isTextNode(node)) {
    return parseTextNode(node);
  }

  if (!isHTMLElement(node)) {
    return;
  }

  const element = node as HTMLElement;
  const tagName = element.tagName;

  // Handle blockquote for annotations
  if (tagName === 'BLOCKQUOTE') {
    return {
      type: 'block',
      blockType: 'quote',
      element,
      annotations: {},
      supportsChildren: true,
    };
  }

  // Handle highlight spans
  if (element.classList.contains('highlight')) {
    const innerSpan = element.querySelector('span');
    const backgroundColor = innerSpan?.style.backgroundColor;
    return {
      type: 'rich_text',
      element,
      annotations: { color: 'yellow_background' }, // We can enhance this later to map colors
    };
  }

  // Handle citation spans
  if (element.classList.contains('citation')) {
    return {
      type: 'rich_text',
      element,
      annotations: {},
    };
  }

  // Handle paragraph
  if (tagName === 'P') {
    return {
      type: 'block',
      blockType: 'paragraph',
      element,
      annotations: {},
      supportsChildren: true,
    };
  }

  // Rest of the existing parseNode logic...
  switch (tagName) {
    case 'A':
      return parseAnchorElement(node as HTMLAnchorElement);
    case 'BODY':
    case 'DIV':
    case 'P':
      return parseBlockElement(node, 'paragraph');
    case 'H1':
      return parseBlockElement(node, 'heading_1');
    case 'H2':
      return parseBlockElement(node, 'heading_2');
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return parseBlockElement(node, 'heading_3');
    case 'LI':
      return parseListItemElement(node);
    case 'OL':
    case 'UL':
      return { element: node, type: 'list' };
    case 'PRE':
      return parsePreElement(node);
    case 'SPAN':
      return parseSpanElement(node);
    default:
      return parseRichTextElement(node);
  }
}
