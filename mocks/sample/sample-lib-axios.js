import axios from 'axios'

const sampleAxios = axios.create({
  baseURL: 'http://0.0.0.0',
  headers: {
    'Content-Type': 'application/json'
  },
  transformRequest: (data) => {
    return JSON.stringify(data)
  },
  transformResponse: (data) => {
    try {
      data = JSON.parse(data)
    } catch (error) {
      console.log(error)
    }
    return data
  }
})

export default sampleAxios
