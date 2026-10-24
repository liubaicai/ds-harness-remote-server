import { LinkOutlined } from '@ant-design/icons'

export function SiteFooter() {
  return <footer className="site-footer app-footer">
    <span>© DSH Remote</span>
    <div className="site-footer-links">
      <a href="/" className="site-footer-link" aria-label="返回首页"><LinkOutlined aria-hidden="true" /><span>返回首页</span></a>
    </div>
    <a className="site-footer-credit" href="https://www.zhihu.com/people/codelover" target="_blank" rel="noreferrer">Power By 知乎@李国宝</a>
  </footer>
}
