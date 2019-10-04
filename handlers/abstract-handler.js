import hash from 'object-hash'
import mppSQLAxios from '../lib/mpp-sql-adapter-axios'
import helper from '../lib/helper'

class AbstractHandler {
  constructor (event, context) {
    if (new.target === AbstractHandler) {
      throw new TypeError('Cannot construct AbstractHandler instances directly')
    }
    this._event = event
    this._context = context
    this._failedQueue = []
    this._notifyQueue = []
    this._successQueue = []
    this._currentJobData = null
    this._queryOptions = {
      type: 'SELECT'
    }
    if (context.hasOwnProperty('responseInterceptors') && context.responseInterceptors.length > 0) {
      context.responseInterceptors.map(interceptor => {
        mppSQLAxios.interceptors.response.use(interceptor.resolved, interceptor.rejected)
      })
    }
    if (!context.hasOwnProperty('notifyThreshold') || !context.notifyThreshold) {
      this._notifyThreshold = process.env.DEFAULT_NOTIFY_RETRIES_THRESHOLD
    }
  }

  // noinspection JSUnusedGlobalSymbols
  // eslint-disable-next-line
  async main (event, context, callback) {
    throw new TypeError('Do not call static abstract method main from child.')
  }

  setQueryOptions (opts) {
    this._queryOptions = { ...this._queryOptions, ...opts }
  }

  async runMPPQuery () {
    const jobInfo = this.getContextLocalData('jobInfo')
    let query = jobInfo.query
    if (jobInfo.queryBindMapping) {
      if (!this._queryOptions.bind) {
        throw new Error('Query binds are set but no binding data passed')
      }
      query = jobInfo.query + ' ' + jobInfo.queryBindMapping.join(', ')
    }
    const { data } = await mppSQLAxios.post('/queries', {
      query: query,
      options: this._queryOptions
    })
    return data
  }

  _checkForFailedRuns () {
    let failedRuns = []
    const localEvent = { payload: '', ...this._event }
    if (this.isReinvoked()) {
      failedRuns = JSON.parse(localEvent.payload)
    }
    return failedRuns
  }

  _getInboundPayloadObject () {
    const localEvent = { body: '', ...this._event }
    if (this.isInbound() && localEvent.body) {
      return JSON.parse(localEvent.body)
    }
  }

  isReinvoked () {
    const localEvent = { source: '', invoker: { invokedFunctionArn: '' }, ...this._event }
    return localEvent.source.toLowerCase() === 'aws.lambda' &&
      process.env.REINVOKER_FUNCTION_ARN.startsWith(localEvent.invoker.invokedFunctionArn)
  }

  isInbound () {
    const localEvent = { requestContext: { resourceId: '', httpMethod: '', apiId: '' }, ...this._event }
    return (
      Boolean(localEvent.requestContext) &&
      Boolean(localEvent.requestContext.resourceId) &&
      Boolean(localEvent.requestContext.httpMethod) &&
      Boolean(localEvent.requestContext.apiId)
    )
  }

  generateHttpResponse (body, code = 200, additionalHeaders = {}) {
    const httpHeaders = this.getContextLocalData('httpHeaders')
    const headers = {
      ...(httpHeaders || {}),
      ...additionalHeaders
    }
    return {
      statusCode: code,
      headers: headers,
      body: JSON.stringify(body)
    }
  }

  // noinspection JSMethodCanBeStatic
  isClientError (error) {
    return error.response &&
      error.response.status &&
      error.response.status < 500
  }

  setCurrentJobData (data) {
    this._currentJobData = data
  }

  getCurrentJobData () {
    return this._currentJobData
  }

  async getJobData () {
    let jobData = this._checkForFailedRuns()
    if (!jobData || jobData.length <= 0) {
      if (this.isInbound()) {
        jobData = this._getInboundPayloadObject()
      } else {
        if (this.isReinvoked()) {
          throw new Error('No payload received from re-invoked event!')
        }
        jobData = await this.runMPPQuery()
      }
    }
    return jobData
  }

  getContextLocalData (key) {
    const localData = {
      notifyRetriesThreshold: this._notifyThreshold,
      ...this._context.localData
    }
    if (localData.hasOwnProperty(key)) {
      return localData[key]
    }
    return null
  }

  async handleFailedQueue (opts = {}) {
    opts = {
      skipMd5Checks: false,
      ...opts
    }
    if (this._failedQueue.length > 0) {
      const event = {
        source: '',
        invoker: { invokedFunctionArn: '' },
        md5Payload: '',
        receiptHandle: '',
        retries: 0,
        ...this._event
      }
      event.source = event.source.toLowerCase()
      if (event.source === 'aws.events') {
        await helper.enqueue_failed_job(this._failedQueue, this._context.functionName)
      } else if (this.isReinvoked()) {
        const stringJobs = helper.get_failed_jobs_as_string(this._failedQueue)
        const md5StringJobs = hash.MD5(stringJobs)
        if (opts.skipMd5Checks || (md5StringJobs.toLowerCase() === event.md5Payload.toLowerCase())) {
          const notifyThresh = parseInt(this.getContextLocalData('notifyRetriesThreshold'), 10)
          const approxRetries = parseInt(event.retries, 10)
          const diff = approxRetries - notifyThresh
          if (diff === 0 || (diff % notifyThresh) === 0) {
            await helper.notify_on_failed_queue({
              job: this.getContextLocalData('jobInfo'),
              event: event,
              queue: this._failedQueue
            })
          }
          await helper.release_failed_job(event.receiptHandle)
        } else {
          await helper.delete_failed_job(event.receiptHandle)
          await helper.enqueue_failed_job(this._failedQueue, this._context.functionName)
        }
      } else {
        throw new Error('Unhandled failed queue event type!')
      }
    }
  }

  async handleNotifyQueue () {
    if (this._notifyQueue.length > 0) {
      const event = {
        source: '',
        invoker: { invokedFunctionArn: '' },
        md5Payload: '',
        receiptHandle: '',
        retries: 0,
        ...this._event
      }
      if (event.source === 'aws.events') {
        await helper.notify_on_failed_queue({
          job: this.getContextLocalData('jobInfo'),
          event: event,
          queue: this._notifyQueue
        })
      } else if (this.isReinvoked()) {
        await helper.notify_on_failed_queue({
          job: this.getContextLocalData('jobInfo'),
          event: event,
          queue: this._notifyQueue
        })
        await helper.delete_failed_job(event.receiptHandle)
      } else {
        throw new Error('Unhandled failed notify queue event type!')
      }
    }
  }

  async handleFailure (error) {
    const event = {
      source: '',
      retries: 0,
      ...this._event
    }
    if (event.source.toLowerCase() === 'aws.events') {
      const jobError = {
        job: this.getContextLocalData('jobInfo'),
        event: event,
        error: error
      }
      if (Boolean(this._currentJobData) && this._currentJobData.length > 0) {
        await helper.enqueue_current_job_data(
          this._currentJobData,
          this._context.functionName
        )
        jobError.currentData = this._currentJobData
      }
      await helper.notify_on_error(jobError)
    } else if (this.isReinvoked()) {
      if (Boolean(this._currentJobData) && this._currentJobData.length > 0) {
        const notifyThresh = parseInt(this.getContextLocalData('notifyRetriesThreshold'), 10)
        const approxRetries = parseInt(event.retries, 10)
        const diff = approxRetries - notifyThresh
        if (diff === 0 || (diff % notifyThresh) === 0) {
          await helper.notify_on_error({
            job: this.getContextLocalData('jobInfo'),
            event: event,
            currentData: this._currentJobData,
            error: error
          })
        }
      } else {
        await helper.notify_on_error({
          job: this.getContextLocalData('jobInfo'),
          event: event,
          error: error
        })
      }
      await helper.release_failed_job(event.receiptHandle)
    } else if (this.isInbound()) {
      await helper.notify_on_error({
        job: this.getContextLocalData('jobInfo'),
        event: event,
        error: error
      })
    } else {
      throw error
    }
  }
}

export default AbstractHandler
