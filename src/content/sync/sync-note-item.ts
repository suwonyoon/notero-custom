import { type Client, isFullBlock } from '@notionhq/client';
import type { BlockObjectRequest } from '@notionhq/client/build/src/api-endpoints';

import {
  getNotionPageID,
  getSyncedNotes,
  saveSyncedNote,
} from '../data/item-data';
import { LocalizableError } from '../errors';

import { convertHtmlToBlocks } from './html-to-notion';
import { LIMITS } from './notion-limits';
import { ChildBlock } from './notion-types';
import { isArchivedOrNotFoundError } from './notion-utils';
import { isAnnotationNote } from '../utils/note-utils';
import { logger } from '../utils';

/**
 * Sync a Zotero note item to Notion as children blocks of the page for its
 * parent regular item.
 *
 * All notes are children of a single toggle heading block on the page. This
 * enables Notero to have a single container on the page where it can update
 * note content without impacting anything else on the page added by the user.
 * Within this top-level container block, each note is contained within its own
 * toggle heading block using the note title.
 *
 * Syncing a note performs the following steps:
 * 1. If the top-level container block ID is not saved in Zotero, create the
 *    block by appending it to the page and save its ID.
 * 2. If a block ID is saved in Zotero for the note's toggle heading, delete
 *    the block (including all its children).
 * 3. Append a new toggle heading block with the note content as a child of
 *    the desired container block.
 *    - For new notes, the container is the top-level container block.
 *    - For existing notes, the container is the existing parent block. This
 *      supports notes within synced blocks as the synced block is used as the
 *      container rather than the top-level container.
 *
 * @param noteItem the Zotero note item to sync to Notion
 * @param notion an initialized Notion `Client` instance
 */
export async function syncNoteItem(
  noteItem: Zotero.Item,
  notion: Client,
): Promise<void> {
  if (noteItem.isTopLevelItem()) {
    throw new LocalizableError(
      'Cannot sync note without a parent item',
      'notero-error-note-without-parent',
    );
  }

  const isAnnotation = isAnnotationNote(noteItem);
  logger.debug(
    `Syncing ${isAnnotation ? 'annotation' : 'regular'} note:`,
    noteItem.getNoteTitle()
  );

  const regularItem = noteItem.topLevelItem;
  const pageID = getNotionPageID(regularItem);

  if (!pageID) {
    throw new LocalizableError(
      'Cannot sync note because its parent item is not synced',
      'notero-error-note-parent-not-synced',
    );
  }

  const syncedNotes = getSyncedNotes(regularItem);
  let { containerBlockID } = syncedNotes;

  if (!containerBlockID) {
    containerBlockID = await createContainerBlock(notion, pageID);
  }

  const existingNoteBlockID = syncedNotes.notes?.[noteItem.key]?.blockID;

  if (existingNoteBlockID) {
    containerBlockID = await getEffectiveContainerBlockID(
      notion,
      existingNoteBlockID,
      containerBlockID,
    );
    await deleteNoteBlock(notion, existingNoteBlockID);
  }

  let newNoteBlockID;

  try {
    newNoteBlockID = await createNoteBlock(
      notion, 
      containerBlockID, 
      noteItem,
      isAnnotation
    );
  } catch (error) {
    if (!isArchivedOrNotFoundError(error)) {
      throw error;
    }

    containerBlockID = await createContainerBlock(notion, pageID);
    newNoteBlockID = await createNoteBlock(
      notion, 
      containerBlockID, 
      noteItem,
      isAnnotation
    );
  } finally {
    await saveSyncedNote(
      regularItem,
      containerBlockID,
      newNoteBlockID,
      noteItem.key,
    );
  }

  await addNoteBlockContent(notion, newNoteBlockID, noteItem, isAnnotation);
}

async function createContainerBlock(
  notion: Client,
  pageID: string,
): Promise<string> {
  const { results } = await notion.blocks.children.append({
    block_id: pageID,
    children: [
      {
        heading_1: {
          rich_text: [{ text: { content: 'Zotero Notes' } }],
          is_toggleable: true,
        },
      },
    ],
  });

  if (!results[0]) {
    throw new LocalizableError(
      'Failed to create container block',
      'notero-error-note-sync-failed',
    );
  }

  return results[0].id;
}

async function createNoteBlock(
  notion: Client,
  containerBlockID: string,
  noteItem: Zotero.Item,
  isAnnotation: boolean = false,
): Promise<string> {
  const response = await notion.blocks.children.append({
    block_id: containerBlockID,
    children: [
      {
        type: 'toggle',
        toggle: {
          rich_text: [
            {
              type: 'text',
              text: {
                content: isAnnotation ? 'PDF Annotations' : noteItem.getNoteTitle(),
              },
            },
          ],
        },
      },
    ],
  });

  if (!isFullBlock(response.results[0])) {
    throw new Error('Failed to create note block');
  }

  const noteBlockID = response.results[0].id;
  
  // Add the content to the note block
  await addNoteBlockContent(notion, noteBlockID, noteItem, isAnnotation);

  return noteBlockID;
}

async function addNoteBlockContent(
  notion: Client,
  noteBlockID: string,
  noteItem: Zotero.Item,
  isAnnotation: boolean = false,
): Promise<void> {
  const blockBatches = buildNoteBlockBatches(noteItem, isAnnotation);

  for (const blocks of blockBatches) {
    await notion.blocks.children.append({
      block_id: noteBlockID,
      children: blocks,
    });
  }
}

function buildNoteBlockBatches(
  noteItem: Zotero.Item,
  isAnnotation: boolean = false,
): BlockObjectRequest[][] {
  let blocks;
  try {
    blocks = convertHtmlToBlocks(noteItem.getNote(), { isAnnotation });
  } catch (error) {
    throw new LocalizableError(
      'Failed to convert note content to Notion blocks',
      'notero-error-note-conversion-failed',
      { cause: error },
    );
  }

  // Ensure blocks is an array
  if (!Array.isArray(blocks)) {
    logger.error('Blocks is not an array:', blocks);
    blocks = [];
  }

  // Safety check for array length
  const batchSize = Math.min(LIMITS.BLOCK_ARRAY_ELEMENTS, 100); // Add a reasonable max limit
  const numBatches = Math.max(1, Math.ceil(blocks.length / batchSize));
  
  logger.debug('Building batches:', {
    totalBlocks: blocks.length,
    batchSize,
    numBatches
  });

  const batches: BlockObjectRequest[][] = [];
  
  for (let i = 0; i < numBatches; i++) {
    const start = i * batchSize;
    const end = Math.min(start + batchSize, blocks.length);
    const batch = blocks.slice(start, end);
    if (batch.length > 0) {
      batches.push(batch);
    }
  }

  logger.debug('Created batches:', batches);
  return batches;
}

async function deleteNoteBlock(notion: Client, blockID: string): Promise<void> {
  try {
    await notion.blocks.delete({ block_id: blockID });
  } catch (error) {
    if (!isArchivedOrNotFoundError(error)) {
      throw error;
    }
  }
}

async function getEffectiveContainerBlockID(
  notion: Client,
  noteBlockID: string,
  containerBlockID: string,
): Promise<string> {
  const block = await notion.blocks.retrieve({ block_id: noteBlockID });

  if (
    isFullBlock(block) &&
    'block_id' in block.parent &&
    block.parent.block_id !== containerBlockID
  ) {
    const parentBlock = await notion.blocks.retrieve({
      block_id: block.parent.block_id,
    });

    if (isFullBlock(parentBlock) && !parentBlock.in_trash) {
      return parentBlock.id;
    }
  }

  return containerBlockID;
}
