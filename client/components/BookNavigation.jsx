import Icon from "./Icon.jsx";

export default function BookNavigation({
  book,
  currentPageId,
  onOpenBook,
  onOpenPage,
  onAddImage,
  disabled = false,
}) {
  const index = book.pages.findIndex((page) => page.id === currentPageId);
  if (index < 0) return null;

  return (
    <nav className="book-navigation" aria-label="文章导航">
      <div className="book-navigation-heading">
        <button
          type="button"
          className="text-button book-return"
          aria-label={`返回书籍：${book.title}`}
          disabled={disabled}
          onClick={onOpenBook}
        >
          <Icon name="back" size={14} />
          返回《{book.title}》
        </button>
        <span className="book-current-position">
          第 {index + 1} / {book.pages.length} 篇
        </span>
      </div>
      <div className="book-navigation-controls">
        <button
          type="button"
          className="button secondary"
          disabled={disabled || index === 0}
          onClick={() => onOpenPage(book.pages[index - 1].id)}
        >
          上一篇
        </button>
        <label className="book-jump">
          <span className="sr-only">跳转到</span>
          <select
            aria-label="书籍文章"
            value={currentPageId}
            disabled={disabled}
            onChange={(event) => onOpenPage(event.target.value)}
          >
            {book.pages.map((page, pageIndex) => (
              <option value={page.id} key={page.id}>
                第 {pageIndex + 1} 篇 · {page.title}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button secondary"
          disabled={disabled || index === book.pages.length - 1}
          onClick={() => onOpenPage(book.pages[index + 1].id)}
        >
          下一篇
        </button>
        <button
          type="button"
          className="button subtle"
          disabled={disabled}
          onClick={onAddImage}
        >
          添加图片文章
        </button>
      </div>
    </nav>
  );
}
