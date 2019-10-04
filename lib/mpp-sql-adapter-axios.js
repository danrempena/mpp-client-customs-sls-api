import axios from 'axios'
import helper from './helper'

export const mppSQLAxiosPublic = axios.create({
  baseURL: process.env.MSA_BASE_URL,
  headers: {
    'Content-Type': 'application/json'
  }
})

export const mppSQLAuthenticate = async () => {
  const { Parameter: { Value: msaClientId } } = await helper.get_ssm_param('MSA_CLIENT_ID')
  const { Parameter: { Value: msaClientSecret } } = await helper.get_ssm_param('MSA_CLIENT_SECRET')
  const { data: { accessToken } } = await mppSQLAxiosPublic.post('/authentication', {
    strategy: 'local',
    clientId: msaClientId,
    clientSecret: msaClientSecret
  })
  return accessToken
}

const mppSQLAxios = axios.create({
  baseURL: process.env.MSA_BASE_URL,
  headers: {
    'Content-Type': 'application/json'
  }
})

mppSQLAxios.interceptors.request.use(async (opts) => {
  let existing = true
  let ssmAccessTokenParam
  try {
    ssmAccessTokenParam = await helper.get_ssm_param('MSA_ACCESS_TOKEN')
  } catch (error) {
    existing = error.code.toLowerCase() !== 'parameternotfound'
    if (existing) throw error
  }
  if (existing &&
    ssmAccessTokenParam &&
    ssmAccessTokenParam.hasOwnProperty('Parameter') &&
    ssmAccessTokenParam.Parameter.Value) {
    if (helper.check_jwt_exp(ssmAccessTokenParam.Parameter.Value)) {
      opts.headers.common['Authorization'] = 'Bearer ' + ssmAccessTokenParam.Parameter.Value
      return opts
    }
  }
  const accessToken = await mppSQLAuthenticate()
  await helper.put_ssm_param({
    Name: 'MSA_ACCESS_TOKEN',
    Value: accessToken
  })
  opts.headers.common['Authorization'] = 'Bearer ' + accessToken
  return opts
}, function (error) {
  return Promise.reject(error)
})

export default mppSQLAxios
