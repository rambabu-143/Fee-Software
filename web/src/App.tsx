import { Button, Layout, Menu, Result, Select, Space, Tag } from 'antd'
import type { ReactNode } from 'react'
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { auth } from './api'
import { can, PAGE_CAP } from './permissions'
import { SessionProvider, useSession } from './session'
import { SelectionProvider, useSelection } from './selection'
import Login from './pages/Login'
import Schools from './pages/Schools'
import Years from './pages/Years'
import Classes from './pages/Classes'
import FeeHeads from './pages/FeeHeads'
import Installments from './pages/Installments'
import FeeStructure from './pages/FeeStructure'
import Transport from './pages/Transport'
import Hostel from './pages/Hostel'
import Students from './pages/Students'
import Promotion from './pages/Promotion'
import CollectFee from './pages/CollectFee'
import Receipts from './pages/Receipts'
import Reports from './pages/Reports'
import Users from './pages/Users'
import Arrears from './pages/Arrears'
import Deposits from './pages/Deposits'
import Vouchers from './pages/Vouchers'
import Banking from './pages/Banking'
import Renewals from './pages/Renewals'
import Documents from './pages/Documents'
import Defaulters from './pages/Defaulters'
import Messaging from './pages/Messaging'
import MoreReports from './pages/MoreReports'
import Masters2 from './pages/Masters2'
import Import from './pages/Import'
import QrSheet from './pages/QrSheet'
import Audit from './pages/Audit'
import Settings from './pages/Settings'

const pages = [
  ['/collect', 'Collect Fee', CollectFee],
  ['/receipts', 'Receipts', Receipts],
  ['/reports', 'Reports', Reports],
  ['/students', 'Students', Students],
  ['/promotion', 'Promotion', Promotion],
  ['/fee-structure', 'Fee Structure', FeeStructure],
  ['/transport', 'Transport', Transport],
  ['/hostel', 'Hostel', Hostel],
  ['/classes', 'Classes & Sections', Classes],
  ['/fee-heads', 'Fee Heads', FeeHeads],
  ['/installments', 'Installments', Installments],
  ['/years', 'Academic Years', Years],
  ['/schools', 'Schools', Schools],
  ['/users', 'Users', Users],
  ['/arrears', 'Arrears', Arrears],
  ['/deposits', 'Deposits', Deposits],
  ['/vouchers', 'Refund Vouchers', Vouchers],
  ['/banking', 'Banking', Banking],
  ['/renewals', 'Transport Renewals', Renewals],
  ['/documents', 'Documents (TC etc.)', Documents],
  ['/defaulters', 'Defaulters', Defaulters],
  ['/messaging', 'SMS & Email', Messaging],
  ['/more-reports', 'More Reports', MoreReports],
  ['/occupations-subjects', 'Occupations & Subjects', Masters2],
  ['/import', 'Bulk Import', Import],
  ['/qr', 'QR Sheet', QrSheet],
  ['/audit', 'Audit Log', Audit],
  ['/settings', 'Settings', Settings],
] as const

function Pickers() {
  const { schools, years, schoolId, yearId, setSchoolId, setYearId } = useSelection()
  return (
    <Space wrap>
      <Select style={{ minWidth: 160 }} value={schoolId} onChange={setSchoolId}
        options={schools.map((s) => ({ value: s.id, label: s.name }))} />
      <Select style={{ minWidth: 100 }} value={yearId} onChange={setYearId}
        options={years.map((y) => ({ value: y.id, label: y.label }))} />
    </Space>
  )
}

// Pages the role can open at all; the rest are hidden from the menu and blocked by URL too.
const allowed = (role: string | undefined, path: string) => !PAGE_CAP[path] || can(role as never, PAGE_CAP[path]!)

function Guard({ path, children }: { path: string; children: ReactNode }) {
  const role = useSession()?.role
  if (allowed(role, path)) return <>{children}</>
  return <Result status="403" title="Not allowed" subTitle={`Your role (${role}) cannot use this page.`}
    extra={<Link to="/students">Back to Students</Link>} />
}

function Shell() {
  const { pathname } = useLocation()
  const session = useSession()
  // Missing, malformed or expired token: same as logged out.
  if (!auth.token || !session) { auth.set(null); return <Navigate to="/login" replace /> }
  return (
    <SelectionProvider>
      <Layout style={{ minHeight: '100vh' }}>
        <Layout.Sider breakpoint="md" collapsedWidth={0}>
          <div style={{ color: '#fff', padding: 16, fontWeight: 600 }}>Fees</div>
          <Menu theme="dark" selectedKeys={[pathname]}
            items={pages.filter(([path]) => allowed(session.role, path)).map(([path, label]) => ({ key: path, label: <Link to={path}>{label}</Link> }))} />
        </Layout.Sider>
        <Layout>
          <Layout.Header style={{ background: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '0 16px', height: 'auto', minHeight: 64, flexWrap: 'wrap' }}>
            <Pickers />
            <Space>
              <span>{session.username} <Tag>{session.role}</Tag></span>
              <Button onClick={() => { auth.set(null); location.href = '/login' }}>Logout</Button>
            </Space>
          </Layout.Header>
          <Layout.Content style={{ padding: 16 }}>
            <Outlet />
          </Layout.Content>
        </Layout>
      </Layout>
    </SelectionProvider>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<SessionProvider><Shell /></SessionProvider>}>
          {pages.map(([path, , Page]) => <Route key={path} path={path} element={<Guard path={path}><Page /></Guard>} />)}
          <Route path="*" element={<Navigate to="/students" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
