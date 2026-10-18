import Link from 'next/link';

/**
 * 自定义 404。
 *
 * 不写这个文件，Next.js 会用内置的英文页面
 * （"404 | This page could not be found."），和全中文界面不一致。
 */
export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <p className="text-5xl font-semibold text-gray-300">404</p>
      <h1 className="mt-4 text-lg font-medium text-gray-900">页面不存在</h1>
      <p className="mt-2 max-w-md text-sm leading-6 text-gray-500">
        你访问的地址没有对应的页面。可能是链接失效，或者对应的知识库已被删除。
      </p>
      <div className="mt-6 flex gap-3">
        <Link
          href="/dashboard"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-700"
        >
          返回工作台
        </Link>
        <Link
          href="/knowledgebase"
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50"
        >
          查看知识库
        </Link>
      </div>
    </div>
  );
}
