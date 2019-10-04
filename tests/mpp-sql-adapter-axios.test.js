import MockAdapter from 'axios-mock-adapter'
import jwt from 'jsonwebtoken'
import mppSQLAxios, { mppSQLAuthenticate, mppSQLAxiosPublic } from '../lib/mpp-sql-adapter-axios'
import helper from '../lib/helper'

jest.mock('../lib/helper')

describe('MPP SQL Adapter Authentication', () => {
  const mppSQLAxiosMock = new MockAdapter(mppSQLAxios)
  const mppSQLAxiosPublicMock = new MockAdapter(mppSQLAxiosPublic)

  beforeEach(() => {
    jest.resetModules()
    mppSQLAxiosMock.reset()
    mppSQLAxiosPublicMock.reset()
    helper._set_mock_client_credentials()
  })

  test('should succeed with public api authentication', async () => {
    const MOCK_ACCESS_TOKEN = jwt.sign({ userId: 1 }, 'secret')
    mppSQLAxiosPublicMock.onPost('/authentication').reply(
      200, {
        accessToken: MOCK_ACCESS_TOKEN
      }
    )
    const accessToken = await mppSQLAuthenticate()
    expect(accessToken).toEqual(MOCK_ACCESS_TOKEN)
  })

  test('should have bearer token on private api request', async () => {
    const MOCK_ACCESS_TOKEN = jwt.sign({ userId: 1 }, 'secret', { expiresIn: '30d' })
    mppSQLAxiosPublicMock.onPost('/authentication').reply(
      200, {
        accessToken: MOCK_ACCESS_TOKEN
      }
    )
    mppSQLAxiosMock.onPost('/queries').reply(config => {
      if (config.headers.hasOwnProperty('Authorization')) {
        if (config.headers.Authorization.trim() === 'Bearer ' + MOCK_ACCESS_TOKEN) {
          return [200, {}]
        }
      }
      return [401, null]
    })
    const result = await mppSQLAxios.post('/queries', { query: 'TEST' })
    const { Parameter: { Value: localSsmAccessToken } } = await helper.get_ssm_param('MPP_SQL_ACCESS_TOKEN')
    expect(localSsmAccessToken).toEqual(MOCK_ACCESS_TOKEN)
    expect(result.status).toEqual(200)
  })

  test('should renew expired bearer token on private api request', async () => {
    const EXPIRED_ACCESS_TOKEN = jwt.sign({ userId: 1 }, 'secret', { expiresIn: '-1h' })
    const RENEWAL_ACCESS_TOKEN = jwt.sign({ userId: 1 }, 'secret', { expiresIn: '30d' })
    const res = await helper.put_ssm_param({
      Name: 'MPP_SQL_ACCESS_TOKEN',
      Value: EXPIRED_ACCESS_TOKEN
    })
    expect(res).toHaveProperty('Version')
    const { Parameter: { Value: ssmExpiredAccessToken } } = await helper.get_ssm_param('MPP_SQL_ACCESS_TOKEN')
    expect(ssmExpiredAccessToken).toEqual(EXPIRED_ACCESS_TOKEN)

    mppSQLAxiosPublicMock.onPost('/authentication').reply(
      200, {
        accessToken: RENEWAL_ACCESS_TOKEN
      }
    )

    mppSQLAxiosMock.onPost('/queries').reply(config => {
      if (config.headers.hasOwnProperty('Authorization')) {
        if (config.headers.Authorization.trim() === 'Bearer ' + RENEWAL_ACCESS_TOKEN) {
          if (helper.check_jwt_exp(RENEWAL_ACCESS_TOKEN)) {
            return [200, {}]
          }
        }
      }
      return [401, null]
    })

    const result = await mppSQLAxios.post('/queries', { query: 'TEST' })
    const { Parameter: { Value: localSsmAccessToken } } = await helper.get_ssm_param('MPP_SQL_ACCESS_TOKEN')
    expect(localSsmAccessToken).toEqual(RENEWAL_ACCESS_TOKEN)
    expect(result.status).toEqual(200)
  })
})
