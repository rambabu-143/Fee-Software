import { Button, Card, Form, Input, message } from 'antd'
import { useNavigate } from 'react-router-dom'
import { api, auth } from '../api'

export default function Login() {
  const navigate = useNavigate()

  async function onFinish(values: { username: string; password: string }) {
    try {
      const { token } = await api<{ token: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(values),
      })
      auth.set(token)
      navigate('/')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#f0f2f5', padding: 16 }}>
      <Card title="Fees Management — Login" style={{ width: '100%', maxWidth: 360 }}>
        <Form layout="vertical" onFinish={onFinish}>
          <Form.Item name="username" label="Username" rules={[{ required: true }]}>
            <Input autoFocus />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            Login
          </Button>
        </Form>
      </Card>
    </div>
  )
}
