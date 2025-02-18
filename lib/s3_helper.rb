# frozen_string_literal: true

require "aws-sdk-s3"

class S3Helper
  FIFTEEN_MEGABYTES = 15 * 1024 * 1024

  class SettingMissing < StandardError; end

  attr_reader :s3_bucket_name, :s3_bucket_folder_path

  ##
  # Controls the following:
  #
  # * cache time for secure-media URLs
  # * expiry time for S3 presigned URLs, which include backup downloads and
  #   any upload that has a private ACL (e.g. secure uploads)
  DOWNLOAD_URL_EXPIRES_AFTER_SECONDS ||= 5.minutes.to_i

  ##
  # Controls the following:
  #
  # * presigned put_object URLs for direct S3 uploads
  UPLOAD_URL_EXPIRES_AFTER_SECONDS ||= 10.minutes.to_i

  def initialize(s3_bucket_name, tombstone_prefix = '', options = {})
    @s3_client = options.delete(:client)
    @s3_options = default_s3_options.merge(options)

    @s3_bucket_name, @s3_bucket_folder_path = begin
      raise Discourse::InvalidParameters.new("s3_bucket_name") if s3_bucket_name.blank?
      self.class.get_bucket_and_folder_path(s3_bucket_name)
    end

    @tombstone_prefix =
      if @s3_bucket_folder_path
        File.join(@s3_bucket_folder_path, tombstone_prefix)
      else
        tombstone_prefix
      end
  end

  def self.get_bucket_and_folder_path(s3_bucket_name)
    s3_bucket_name.downcase.split("/", 2)
  end

  def upload(file, path, options = {})
    path = get_path_for_s3_upload(path)
    obj = s3_bucket.object(path)

    etag = begin
      if File.size(file.path) >= FIFTEEN_MEGABYTES
        options[:multipart_threshold] = FIFTEEN_MEGABYTES
        obj.upload_file(file, options)
        obj.load
        obj.etag
      else
        options[:body] = file
        obj.put(options).etag
      end
    end

    [path, etag.gsub('"', '')]
  end

  def remove(s3_filename, copy_to_tombstone = false)
    s3_filename = s3_filename.dup

    # copy the file in tombstone
    if copy_to_tombstone && @tombstone_prefix.present?
      self.copy(
        get_path_for_s3_upload(s3_filename),
        File.join(@tombstone_prefix, s3_filename)
      )
    end

    # delete the file
    s3_filename.prepend(multisite_upload_path) if Rails.configuration.multisite
    delete_object(get_path_for_s3_upload(s3_filename))
  rescue Aws::S3::Errors::NoSuchKey
  end

  def delete_object(key)
    s3_bucket.object(key).delete
  rescue Aws::S3::Errors::NoSuchKey
  end

  def copy(source, destination, options: {})
    destination = get_path_for_s3_upload(destination)
    if !Rails.configuration.multisite
      options[:copy_source] = File.join(@s3_bucket_name, source)
    else
      if source.include?(multisite_upload_path) || source.include?(@tombstone_prefix)
        options[:copy_source] = File.join(@s3_bucket_name, source)
      elsif @s3_bucket_folder_path
        folder, filename = begin
                             source.split("/", 2)
                           end
        options[:copy_source] = File.join(@s3_bucket_name, folder, multisite_upload_path, filename)
      else
        options[:copy_source] = File.join(@s3_bucket_name, multisite_upload_path, source)
      end
    end

    response = s3_bucket.object(destination).copy_from(options)
    [destination, response.copy_object_result.etag.gsub('"', '')]
  end

  # make sure we have a cors config for assets
  # otherwise we will have no fonts
  def ensure_cors!(rules = nil)
    return unless SiteSetting.s3_install_cors_rule

    rule = nil

    begin
      rule = s3_resource.client.get_bucket_cors(
        bucket: @s3_bucket_name
      ).cors_rules&.first
    rescue Aws::S3::Errors::NoSuchCORSConfiguration
      # no rule
    end

    unless rule
      rules = [{
        allowed_headers: ["Authorization"],
        allowed_methods: ["GET", "HEAD"],
        allowed_origins: ["*"],
        max_age_seconds: 3000
      }] if rules.nil?

      s3_resource.client.put_bucket_cors(
        bucket: @s3_bucket_name,
        cors_configuration: {
          cors_rules: rules
        }
      )
    end
  end

  def update_lifecycle(id, days, prefix: nil, tag: nil)
    filter = {}

    if prefix
      filter[:prefix] = prefix
    elsif tag
      filter[:tag] = tag
    end

    # cf. http://docs.aws.amazon.com/AmazonS3/latest/dev/object-lifecycle-mgmt.html
    rule = {
      id: id,
      status: "Enabled",
      expiration: { days: days },
      filter: filter
    }

    rules = []

    begin
      rules = s3_resource.client.get_bucket_lifecycle_configuration(bucket: @s3_bucket_name).rules
    rescue Aws::S3::Errors::NoSuchLifecycleConfiguration
      # skip trying to merge
    end

    # in the past we has a rule that was called purge-tombstone vs purge_tombstone
    # just go ahead and normalize for our bucket
    rules.delete_if do |r|
      r.id.gsub('_', '-') == id.gsub('_', '-')
    end

    rules << rule

    # normalize filter in rules, due to AWS library bug
    rules = rules.map do |r|
      r = r.to_h
      prefix = r.delete(:prefix)
      if prefix
        r[:filter] = { prefix: prefix }
      end
      r
    end

    s3_resource.client.put_bucket_lifecycle_configuration(
      bucket: @s3_bucket_name,
      lifecycle_configuration: {
        rules: rules
    })
  end

  def update_tombstone_lifecycle(grace_period)
    return if !SiteSetting.s3_configure_tombstone_policy
    return if @tombstone_prefix.blank?
    update_lifecycle("purge_tombstone", grace_period, prefix: @tombstone_prefix)
  end

  def list(prefix = "", marker = nil)
    options = { prefix: get_path_for_s3_upload(prefix) }
    options[:marker] = marker if marker.present?
    s3_bucket.objects(options)
  end

  def tag_file(key, tags)
    tag_array = []
    tags.each do |k, v|
      tag_array << { key: k.to_s, value: v.to_s }
    end

    s3_resource.client.put_object_tagging(
      bucket: @s3_bucket_name,
      key: key,
      tagging: {
        tag_set: tag_array
      }
    )
  end

  def object(path)
    s3_bucket.object(get_path_for_s3_upload(path))
  end

  def self.s3_options(obj)
    opts = {
      region: obj.s3_region
    }

    opts[:endpoint] = SiteSetting.s3_endpoint if SiteSetting.s3_endpoint.present?
    opts[:http_continue_timeout] = SiteSetting.s3_http_continue_timeout

    unless obj.s3_use_iam_profile
      opts[:access_key_id] = obj.s3_access_key_id
      opts[:secret_access_key] = obj.s3_secret_access_key
    end

    opts
  end

  def download_file(filename, destination_path, failure_message = nil)
    object(filename).download_file(destination_path)
  rescue => err
    raise failure_message&.to_s || "Failed to download #{filename} because #{err.message.length > 0 ? err.message : err.class.to_s}"
  end

  def s3_client
    @s3_client ||= Aws::S3::Client.new(@s3_options)
  end

  def s3_inventory_path(path = 'inventory')
    get_path_for_s3_upload(path)
  end

  private

  def default_s3_options
    if SiteSetting.enable_s3_uploads?
      options = self.class.s3_options(SiteSetting)
      check_missing_site_options
      options
    elsif GlobalSetting.use_s3?
      self.class.s3_options(GlobalSetting)
    else
      {}
    end
  end

  def get_path_for_s3_upload(path)
    if @s3_bucket_folder_path &&
        !path.starts_with?(@s3_bucket_folder_path) &&
        !path.starts_with?(File.join(FileStore::BaseStore::TEMPORARY_UPLOAD_PREFIX, @s3_bucket_folder_path))
      return File.join(@s3_bucket_folder_path, path)
    end

    path
  end

  def multisite_upload_path
    path = File.join("uploads", RailsMultisite::ConnectionManagement.current_db, "/")
    return path if !Rails.env.test?
    File.join(path, "test_#{ENV['TEST_ENV_NUMBER'].presence || '0'}", "/")
  end

  def s3_resource
    Aws::S3::Resource.new(client: s3_client)
  end

  def s3_bucket
    @s3_bucket ||= begin
      bucket = s3_resource.bucket(@s3_bucket_name)
      bucket.create unless bucket.exists?
      bucket
    end
  end

  def check_missing_site_options
    unless SiteSetting.s3_use_iam_profile
      raise SettingMissing.new("access_key_id") if SiteSetting.s3_access_key_id.blank?
      raise SettingMissing.new("secret_access_key") if SiteSetting.s3_secret_access_key.blank?
    end
  end
end
