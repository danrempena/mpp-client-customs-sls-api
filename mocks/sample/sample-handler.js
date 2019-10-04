import sampleAxios from './sample-lib-axios'
import AbstractHandler from '../../handlers/abstract-handler'
import helper from '../../lib/helper'

export class SampleHandler extends AbstractHandler {
  async main (callback) {
    try {
      const jobData = await this.getJobData()
      if (Boolean(jobData) && jobData.length) {
        this._currentJobData = jobData
        console.log('Processing Data: ', jobData.length)
        const self = this
        await Promise.all(jobData.map(async (jobEntry) => {
          try {
            const result = await self.customSampleJob(jobEntry)
            self._successQueue.push({ data: jobEntry, result: result })
          } catch (error) {
            console.error('Failure for: ', jobEntry, error)
            if (self.isClientError(error)) {
              self._notifyQueue.push({ data: jobEntry, error: error })
            } else {
              self._failedQueue.push({ data: jobEntry, error: error })
            }
          }
        }))
      } else {
        console.log('No available data to process!')
      }
      if (this._failedQueue.length > 0) {
        await this.handleFailedQueue()
      } else if (this.isReinvoked() && this._successQueue.length > 0) {
        await helper.delete_failed_job(this._event.receiptHandle)
      }
      if (this._notifyQueue.length > 0) {
        await this.handleNotifyQueue()
      }
      callback(null, {
        'success': this._successQueue,
        'fail': this._failedQueue,
        'notify': this._notifyQueue
      })
    } catch (error) {
      console.error(error)
      await this.handleFailure(error)
      callback(error)
    }
  }

  async customSampleJob (jobData) {
    const jobInfo = this.getContextLocalData('jobInfo')
    const results = await sampleAxios.post('/sample-api', jobData)
    if (!results.data) {
      throw new Error('No response received from targetEndpoint!')
    }
    console.log('Request:', jobInfo.targetEndpoint, jobData)
    console.log('Response:', jobInfo.targetEndpoint, results.data)
    if (!results.data.result) {
      throw new Error(JSON.stringify(results.data))
    }
    return results
  }
}

export const jobInfo = {
  id: 'sampleJob',
  name: 'A sample mock job',
  query: 'EXEC [dbo].[mlm_SampleMPPQuery]',
  targetEndpoint: 'http://0.0.0.0/sample-api'
}

export const main = async (event, context, callback) => {
  context['localData'] = {
    jobInfo: jobInfo
  }
  const handler = new SampleHandler(event, context)
  await handler.main(callback)
}
