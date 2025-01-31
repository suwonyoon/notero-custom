export function isAnnotationNote(noteItem: Zotero.Item): boolean {
  const noteTitle = noteItem.getNoteTitle();
  return noteTitle.includes('Annotation');
} 