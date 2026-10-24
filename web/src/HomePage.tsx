import { ArrowRightOutlined, CheckOutlined, CopyOutlined, GithubOutlined, LockOutlined } from '@ant-design/icons'
import { useEffect, useRef, useState } from 'react'
import { navigate } from './main'
import { REPOSITORY_URL } from './links'
import { ThemeToggle } from './ThemeToggle'
import './home.css'

const REMOTE_PATH = '/app/remote'
const DSH_COMMAND = 'dsh plugin --profile web add ds-harness-remote@0.5.2'

function openRemote(event: React.MouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  navigate(REMOTE_PATH)
}

function InstallCommand() {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout>>()
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; clearTimeout(resetTimer.current) }
  }, [])

  async function copy() {
    clearTimeout(resetTimer.current)
    try {
      await navigator.clipboard.writeText(DSH_COMMAND)
      if (!mounted.current) return
      setStatus('copied')
      resetTimer.current = setTimeout(() => setStatus('idle'), 2000)
    } catch { if (mounted.current) setStatus('error') }
  }

  return <>
    <div className="landing-command">
      <code>{DSH_COMMAND}</code>
      <button type="button" onClick={() => void copy()} aria-label={status === 'copied' ? '已复制安装命令' : '复制安装命令'} title={status === 'copied' ? '已复制' : '复制命令'}>
        {status === 'copied' ? <CheckOutlined /> : <CopyOutlined />}
      </button>
    </div>
    <span className="sr-only" role="status">{status === 'copied' ? '安装命令已复制' : ''}</span>
    {status === 'error' && <p className="landing-copy-error" role="alert">复制失败，请选中命令手动复制。</p>}
  </>
}

export function HomePage() {
  return <div className="landing-shell">
    <a className="landing-skip" href="#landing-main">跳转到主要内容</a>
    <header className="landing-header">
      <div className="landing-container landing-header-inner">
        <a className="landing-brand" href="/" aria-label="DeepSeek Harness Remote 首页">
          <span className="landing-brand-mark" aria-hidden="true" />
          <span>DeepSeek Harness Remote</span>
        </a>
        <nav className="landing-nav" aria-label="主导航">
          <a className="landing-nav-github" href={REPOSITORY_URL} target="_blank" rel="noreferrer"><GithubOutlined /><span>GitHub</span></a>
          <a className="landing-nav-start" href={REMOTE_PATH} onClick={openRemote}>开始使用</a>
          <ThemeToggle />
        </nav>
      </div>
    </header>

    <main id="landing-main" className="landing-container" tabIndex={-1}>
      <section className="landing-intro" aria-labelledby="landing-title">
        <div className="landing-copy">
          <p className="landing-eyebrow"><LockOutlined />自部署远程连接</p>
          <h1 id="landing-title">随时连接，<br />继续你的工作。</h1>
          <p className="landing-description">通过手机或另一台电脑，安全访问工作电脑上的 DeepSeek Harness。</p>
          <div className="landing-actions">
            <a className="landing-button landing-button-primary" href={REMOTE_PATH} onClick={openRemote}>开始使用<ArrowRightOutlined /></a>
            <a className="landing-button landing-button-secondary" href={REPOSITORY_URL} target="_blank" rel="noreferrer"><GithubOutlined />查看源码</a>
          </div>
          <p className="landing-workspaces">支持 DSH 与 Codex 工作区</p>
        </div>

        <aside className="landing-setup" aria-labelledby="landing-setup-title">
          <h2 id="landing-setup-title">连接工作电脑</h2>
          <ol className="landing-setup-steps">
            <li>
              <h3>安装并启用 Remote 插件</h3>
              <InstallCommand />
            </li>
            <li>
              <h3>完成账号授权</h3>
              <p>在工作电脑上启动 DeepSeek Harness，然后在 Remote 插件中登录账号。</p>
            </li>
          </ol>
        </aside>
      </section>

      <section className="landing-features" aria-label="安全与设备管理">
        <dl>
          <div><dt>端到端加密</dt><dd>业务内容仅对已授权设备可见。</dd></div>
          <div><dt>工作区保留在本机</dt><dd>源码与文件无需上传到服务器。</dd></div>
          <div><dt>设备授权可管理</dt><dd>查看在线状态，移除不再使用的设备。</dd></div>
        </dl>
      </section>
    </main>

    <footer className="landing-container landing-footer">
      <span>© DSH Remote</span>
      <a href="https://www.zhihu.com/people/codelover" target="_blank" rel="noreferrer">原项目作者 李国宝</a>
    </footer>
  </div>
}
