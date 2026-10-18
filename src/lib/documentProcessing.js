import fs from 'fs/promises';
import path from 'path';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';

/**
 * 切分参数（PDF 和纯文本共用，改一处两边都生效）。
 *
 * 实测依据：705 字的文档按 chunkSize 1000 切只出 1 块，
 * 检索会退化成「整篇匹配」——表现为「文档里有答案」的查询得分
 * 反而低于「文档里没有」的查询。切到 400 后正确答案能从 Top2 升到 Top1。
 *
 * chunkOverlap 取 chunkSize 的 25%，是为了避免答案正好被切在块的边界上，
 * 导致前后两块各自都不完整。
 */
const CHUNK_SIZE = 400;
const CHUNK_OVERLAP = 100;

/**
 * 切分参数来自 /settings（按用户），调用方传进来；不传就用默认值。
 * 注意：改切分只影响**新上传**的文档 —— 已入库的块不会再被重新切。
 */
function createSplitter(options = {}) {
  const chunkSize = Math.max(120, Math.min(2000, Number(options.chunkSize) || CHUNK_SIZE));
  const chunkOverlap = Math.max(
    0,
    Math.min(500, Math.min(Number(options.chunkOverlap) || 0, chunkSize - 1)),
  );
  return new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });
}

/**
 * 把上传的文件解析成「可入库的 chunk 数组」。
 *
 * 返回结构（约定）：
 *   [{ content: string, metadata: ChunkMetadata }]
 *
 * ChunkMetadata 里会尽量带上「能定位回原文」的字段，引用溯源全靠它：
 *   documentId   文档 ID
 *   fileName     原始文件名（用户看到的那个，不是磁盘名）
 *   fileType     MIME
 *   chunkIndex   块序号（0 起，全文档连续）
 *   pageNumber   PDF 的页码（1 起）；非 PDF 没有这个字段
 */
export async function processDocument(filePath, fileType, documentId, originalName, splitOptions) {
  try {
    switch (fileType) {
      case 'application/pdf':
        return await processPdf(filePath, documentId, originalName, splitOptions);

      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
        const text = await processDocx(filePath);
        return await splitTextIntoChunks(text, fileType, originalName, documentId, splitOptions);
      }

      case 'text/plain':
      case 'text/markdown': {
        const text = await processTextFile(filePath);
        return await splitTextIntoChunks(text, fileType, originalName, documentId, splitOptions);
      }

      default:
        throw new Error(`Unsupported file type: ${fileType}`);
    }
  } catch (error) {
    console.error('Error processing document:', error);
    throw error;
  }
}

/**
 * PDF：**先按页取文本，再在每一页内部切分**。
 *
 * ── 为什么不是「一页一块」──
 * 原来的实现是 PDFLoader 出来多少页就返回多少块，一页技术文档可能 3000 字，
 * 粒度太粗，和文本文件按 1000 切是同一个毛病：向量代表的是「整页的平均语义」，
 * 具体问题命中不了具体段落。
 *
 * ── 为什么不「整篇切完再映射回页码」──
 * 那样虽然允许跨页连续，但要把每个 chunk 的字符偏移反查回页号，逻辑绕且容易错。
 * 按页切则天然知道页码，代码也直白。
 *
 * 代价：chunk 不会跨页。对 400 字的块来说，一页能切出好几块，
 * 只有每页首尾那两块会损失一点跨页上下文，换来的是**页码绝对准确**——
 * 而页码是「点引用跳到 PDF 对应页」这个功能的前提，值得。
 */
async function processPdf(filePath, documentId, originalName, splitOptions) {
  try {
    const loader = new PDFLoader(filePath);
    const pages = await loader.load();
    const splitter = createSplitter(splitOptions);

    const chunks = [];

    for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
      const page = pages[pageIdx];
      // PDFLoader 给的是 1 起的页码；取不到就退化成「第 pageIdx+1 页」
      const pageNumber = page.metadata?.loc?.pageNumber ?? pageIdx + 1;

      const pieces = await splitter.splitText(page.pageContent);
      if (pieces.length === 0) continue; // 空白页跳过

      pieces.forEach((content, pageChunkIndex) => {
        chunks.push({
          content,
          metadata: {
            documentId,
            fileName: originalName ?? path.basename(filePath),
            fileType: 'application/pdf',
            // 全文档连续的块序号 —— 引用卡片显示「第 N 块」用它
            chunkIndex: chunks.length,
            // ★ 页码：引用预览靠它跳页，必须准
            pageNumber,
            // 这一块在「本页内」是第几块（0 起），用于展示「第 3 页 第 2 段」
            pageChunkIndex,
            pageCount: pages.length,
          },
        });
      });
    }

    return chunks;
  } catch (error) {
    console.error('Error parsing PDF:', error);
    throw error;
  }
}

/**
 * DOCX —— ⚠️ 目前是坏的。
 *
 * docx 本质是 zip 二进制包，用 utf8 读出来是乱码。
 * 项目里其实装了 docx-parser 依赖但没用上。
 * 这里保持原样未修，引用预览会走「该格式不支持」的分支。
 */
async function processDocx(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content.toString();
  } catch (error) {
    console.error('Error parsing DOCX:', error);
    throw error;
  }
}

async function processTextFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content;
  } catch (error) {
    console.error('Error parsing text file:', error);
    throw error;
  }
}

/** TXT / MD：整篇递归字符切分 */
async function splitTextIntoChunks(text, fileType, fileName, documentId, splitOptions) {
  const rawChunks = await createSplitter(splitOptions).splitText(text);

  return rawChunks.map((content, index) => ({
    content,
    metadata: {
      documentId,
      fileName,
      fileType,
      chunkIndex: index,
      chunkCount: rawChunks.length,
    },
  }));
}
